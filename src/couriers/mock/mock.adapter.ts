import { CourierError } from '../../errors/courier-error';
import type { ErrorCode } from '../../errors/error-codes';
import type {
  CourierAdapter,
  CourierConfig,
  CourierContext,
  CourierFactory,
} from '../courier.interface';
import type {
  CancellationResult,
  NormalizedOrder,
  ShipmentRef,
  ShipmentResult,
  ShipmentStatus,
  TrackingEvent,
  TrackingResult,
} from '../shipment.types';

/** One step per tracking poll. */
const LIFECYCLE: readonly ShipmentStatus[] = [
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

/** Failures steered by `metadata.mock` on the order; absence means succeed. */
interface SimulatedFailure {
  code: ErrorCode;
  rawResponse?: unknown;
  response: unknown;
}

const DIRECTIVES: Record<string, SimulatedFailure> = {
  reject: {
    code: 'COURIER_REJECTED',
    rawResponse: { status: 'Failed', message: 'MOCK: rejected by directive' },
    response: { status: 'Failed' },
  },
  timeout: { code: 'COURIER_TIMEOUT', response: { error: 'ETIMEDOUT' } },
  duplicate: {
    code: 'DUPLICATE_ORDER',
    rawResponse: { message: 'MOCK: already shipped' },
    response: { status: 'Failed' },
  },
  'auth-fail': { code: 'COURIER_AUTH_FAILED', response: { status: 401 } },
  unavailable: { code: 'COURIER_UNAVAILABLE', response: { status: 503 } },
};

const RANDOM_OUTAGE: SimulatedFailure = { code: 'COURIER_UNAVAILABLE', response: { status: 503 } };

/** `metadata.mock = 'slow'` makes createShipment take this long — for testing in-flight races. */
const SLOW_MS = 400;

const MAX_SHIPMENTS = 10_000;

interface MockShipment {
  step: number;
  cancelled: boolean;
  createdAt: number;
  /** `metadata.mock = 'unknown-status'`: tracking reports a code the status map does not know. */
  unknownStatus: boolean;
}

/** Deterministic in-memory partner for tests and local dev; state does not survive a restart. */
class MockCourierAdapter implements CourierAdapter {
  readonly key = 'mock';
  readonly displayName = 'Mock Courier';
  readonly idempotentOnReference: boolean;

  private readonly shipments = new Map<string, MockShipment>();
  private readonly failureRate: number;
  private sequence = 0;

  constructor(config: CourierConfig) {
    this.failureRate = Number(config.credentials.failureRate ?? 0);
    this.idempotentOnReference = (config.credentials.idempotentOnReference ?? 'true') === 'true';
  }

  async createShipment(order: NormalizedOrder, ctx: CourierContext): Promise<ShipmentResult> {
    const directive = typeof order.metadata?.mock === 'string' ? order.metadata.mock : undefined;
    const request = { orderNumber: order.orderId, consignee: order.drop.name, directive };

    if (directive === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    }

    const failure =
      (directive && DIRECTIVES[directive]) ||
      (this.failureRate > 0 && Math.random() < this.failureRate ? RANDOM_OUTAGE : undefined);
    if (failure) {
      ctx.audit({ request, response: failure.response, durationMs: 0 });
      throw new CourierError(failure.code, {
        courierPartner: this.key,
        rawResponse: failure.rawResponse,
      });
    }

    this.sequence += 1;
    const awb = `MOCK${String(this.sequence).padStart(10, '0')}`;
    if (this.shipments.size >= MAX_SHIPMENTS) {
      this.shipments.delete(this.shipments.keys().next().value!);
    }
    this.shipments.set(awb, {
      step: 0,
      cancelled: false,
      createdAt: Date.now(),
      unknownStatus: directive === 'unknown-status',
    });

    // Mints its own id, unlike UrbaneBolt.
    const result: ShipmentResult = {
      courierOrderId: `MOCK-ORD-${this.sequence}`,
      awb,
      labelUrl: `https://mock.courier.local/labels/${awb}.pdf`,
      routeCode: 'MOCK/HUB',
    };
    ctx.audit({ request, response: { status: 'Success', ...result }, durationMs: 0 });
    return result;
  }

  async trackShipment(ref: ShipmentRef, ctx: CourierContext): Promise<TrackingResult> {
    const shipment = this.shipmentFor(ref);

    if (!shipment.cancelled && shipment.step < LIFECYCLE.length - 1) {
      shipment.step += 1;
    }

    const events: TrackingEvent[] = LIFECYCLE.slice(0, shipment.step + 1).map((status, i) =>
      this.event(shipment, status, i),
    );
    if (shipment.cancelled) {
      events.push(this.event(shipment, 'CANCELLED', shipment.step + 1));
    }

    if (shipment.unknownStatus) {
      // A code the map has never seen: kept with status null, never guessed at.
      events.push({
        status: null,
        courierStatusCode: 'MOCK_ZZZ',
        courierStatusText: 'something new',
        location: 'Mock Hub',
        occurredAt: new Date(shipment.createdAt + (shipment.step + 2) * 3_600_000),
        raw: { status: 'ZZZ' },
      });
    }

    const current = events.at(-1)!;
    ctx.audit({ request: { awb: ref.awb }, response: { events }, durationMs: 0 });
    return {
      awb: ref.awb,
      status: current.status,
      courierStatusCode: current.courierStatusCode,
      courierStatusText: current.courierStatusText,
      currentLocation: current.location,
      events,
    };
  }

  async cancelShipment(ref: ShipmentRef, ctx: CourierContext): Promise<CancellationResult> {
    const shipment = this.shipmentFor(ref);

    // Refuse once picked up, as real couriers do.
    if (shipment.step >= 1) {
      ctx.audit({ request: { awb: ref.awb }, response: { status: 'Failed' }, durationMs: 0 });
      throw new CourierError('COURIER_REJECTED', {
        courierPartner: this.key,
        rawResponse: { message: 'MOCK: shipment already picked up' },
      });
    }
    shipment.cancelled = true;
    ctx.audit({ request: { awb: ref.awb }, response: { status: 'Success' }, durationMs: 0 });
    return { cancelled: true, message: 'Cancelled' };
  }

  private shipmentFor(ref: ShipmentRef): MockShipment {
    const shipment = this.shipments.get(ref.awb);
    if (!shipment) {
      throw new CourierError('ORDER_NOT_FOUND', {
        courierPartner: this.key,
        rawResponse: { status: 'Failed', message: 'Data Not Found' },
      });
    }
    return shipment;
  }

  private event(shipment: MockShipment, status: ShipmentStatus, step: number): TrackingEvent {
    return {
      status,
      courierStatusCode: `MOCK_${status}`,
      courierStatusText: status.replace('_', ' ').toLowerCase(),
      location: 'Mock Hub',
      occurredAt: new Date(shipment.createdAt + step * 3_600_000),
      raw: { step, status },
    };
  }
}

const factory: CourierFactory = (config: CourierConfig) => new MockCourierAdapter(config);
export default factory;
