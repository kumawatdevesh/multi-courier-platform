import { requireCredential } from '../../config/couriers';
import { logger } from '../../lib/logger';
import type {
  CourierAdapter,
  CourierConfig,
  CourierContext,
  CourierFactory,
} from '../courier.interface';
import type {
  Address,
  CancellationResult,
  NormalizedOrder,
  ShipmentRef,
  ShipmentResult,
  TrackingEvent,
  TrackingResult,
} from '../shipment.types';
import { UrbaneBoltClient, type UbScan, type UbTrackingData } from './urbanebolt.client';
import { toShipmentStatus } from './urbanebolt.status-map';

const SERVICE_TYPES: Record<string, string> = {
  SAME_DAY: 'SDD',
  NEXT_DAY: 'NDD',
  EXPRESS: 'EXP',
  SURFACE: 'SUR',
};

class UrbaneBoltAdapter implements CourierAdapter {
  readonly key = 'urbanebolt';
  readonly displayName = 'UrbaneBolt';
  /** Verified in UAT: a second manifest for the same orderNumber is "already shipped!". */
  readonly idempotentOnReference = true;

  private readonly client: UrbaneBoltClient;
  private readonly customerCode: string;
  private readonly defaultServiceType: string;

  constructor(config: CourierConfig) {
    this.customerCode = requireCredential(config, 'customerCode');
    this.defaultServiceType = config.credentials.serviceType ?? 'SDD';
    this.client = new UrbaneBoltClient(config);
  }

  async createShipment(order: NormalizedOrder, ctx: CourierContext): Promise<ShipmentResult> {
    const created = await this.client.manifest(this.toManifestPayload(order), ctx);

    return {
      // UrbaneBolt mints no id of its own; orderNumber is our reference, echoed back.
      courierOrderId: created.orderNumber,
      // awbNumber is a JSON number; String() rather than a cast avoids precision loss.
      awb: String(created.awbNumber),
      labelUrl: created.shippingLabel,
      routeCode: created.routeCode,
    };
  }

  async trackShipment(ref: ShipmentRef, ctx: CourierContext): Promise<TrackingResult> {
    const data = await this.client.track(ref.awb, ctx);
    const events = this.toTrackingEvents(data, ctx);

    const currentCode = data.currentStatusCode ?? '';
    const currentStatus = toShipmentStatus(currentCode);
    if (!currentStatus) {
      logger.warn(
        { courierPartner: this.key, requestId: ctx.requestId, awb: ref.awb, code: currentCode },
        'unmapped UrbaneBolt status code — order status left unchanged',
      );
    }

    return {
      awb: String(data.awbNumber ?? ref.awb),
      status: currentStatus,
      courierStatusCode: currentCode,
      courierStatusText: data.currentStatusCodeDescription ?? '',
      currentLocation: data.currentLocation,
      estimatedDeliveryDate: data.edd,
      events,
    };
  }

  async cancelShipment(ref: ShipmentRef, ctx: CourierContext): Promise<CancellationResult> {
    const result = await this.client.cancel(ref.awb, ctx);
    return { cancelled: true, message: result.message };
  }

  // --- mapping ---------------------------------------------------------------

  private toManifestPayload(order: NormalizedOrder): Record<string, unknown> {
    const returnTo = order.returnTo ?? order.pickup;

    return {
      customerCode: this.customerCode,
      orderNumber: order.orderId,
      serviceType: SERVICE_TYPES[order.serviceType ?? ''] ?? this.defaultServiceType,
      payMode: order.paymentMode === 'COD' ? 'COD' : 'PPD',
      collectableValue: order.paymentMode === 'COD' ? (order.codAmount ?? 0) : 0,

      itemDescription: order.parcel.description,
      declaredValue: order.parcel.declaredValue,
      itemQuantity: order.parcel.pieces,
      pieces: order.parcel.pieces,
      weight: order.parcel.weightKg,
      length: order.parcel.lengthCm,
      breadth: order.parcel.breadthCm,
      height: order.parcel.heightCm,

      invoiceNumber: order.invoice.number,
      invoiceDate: order.invoice.date,
      invoiceValue: order.invoice.value,

      ...this.toPartyFields('shpr', order.pickup),
      ...this.toPartyFields('cons', order.drop),
      ...this.toPartyFields('rtn', returnTo),
    };
  }

  /** One block for shpr/cons/rtn. Pincode and mobile go out unquoted, as the samples do. */
  private toPartyFields(prefix: 'shpr' | 'cons' | 'rtn', address: Address) {
    const line = [address.line1, address.line2].filter(Boolean).join(', ');
    return {
      [`${prefix}Name`]: address.name,
      [`${prefix}Address`]: line,
      [`${prefix}AddressType`]: address.type === 'SELLER' ? 'Seller' : 'Home',
      [`${prefix}City`]: address.city,
      [`${prefix}State`]: address.state,
      [`${prefix}Country`]: address.country,
      [`${prefix}Pincode`]: Number(address.pincode),
      [`${prefix}Mobile`]: Number(address.phone),
      [`${prefix}Email`]: address.email ?? '',
    };
  }

  private toTrackingEvents(data: UbTrackingData, ctx: CourierContext): TrackingEvent[] {
    const scans = data.scans ?? [];

    return scans
      .map((scan) => this.toTrackingEvent(scan, ctx))
      .filter((event): event is TrackingEvent => event !== null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  /** Unknown codes are kept with status null; only a scan with no usable timestamp is skipped. */
  private toTrackingEvent(scan: UbScan, ctx: CourierContext): TrackingEvent | null {
    const code = scan.statusCode ?? '';
    const occurredAt = parseScanDate(scan.statusDateTime);

    if (!occurredAt) {
      logger.warn(
        { courierPartner: this.key, requestId: ctx.requestId, code, at: scan.statusDateTime },
        'skipping UrbaneBolt scan with unparseable timestamp',
      );
      return null;
    }

    return {
      status: toShipmentStatus(code),
      courierStatusCode: code,
      courierStatusText: scan.statusCodeDescription ?? '',
      location: scan.currentLocation || undefined,
      occurredAt,
      raw: scan,
    };
  }
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parses "03 May 2025, 15:47" (no timezone; UAT reports IST). Null, not the epoch, on garbage. */
export function parseScanDate(value: string | undefined): Date | null {
  if (!value) return null;

  const match = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/.exec(
    value.trim(),
  );
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, day, monthName, year, hour, minute] = match;
  const month = MONTHS[monthName!.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  const utcMs =
    Date.UTC(Number(year), month, Number(day), Number(hour ?? 0), Number(minute ?? 0)) -
    (5 * 60 + 30) * 60_000;

  return new Date(utcMs);
}

const factory: CourierFactory = (config: CourierConfig) => new UrbaneBoltAdapter(config);
export default factory;
