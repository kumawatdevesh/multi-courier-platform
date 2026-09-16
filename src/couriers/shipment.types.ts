/** The normalized shipment model. Nothing courier-specific belongs here. */

export const SHIPMENT_STATUSES = [
  'PENDING', // accepted by us, not yet sent to the courier
  'PROCESSING', // claimed by a worker; courier call in flight
  'CREATED', // courier has manifested it, AWB issued
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RTO', // return to origin
  'CANCELLED',
  'FAILED', // courier rejected it, or retries exhausted
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Statuses a shipment cannot leave. */
export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
  'DELIVERED',
  'RTO',
  'CANCELLED',
  'FAILED',
]);

export const PAYMENT_MODES = ['PREPAID', 'COD'] as const;
export const SERVICE_TYPES = ['SAME_DAY', 'NEXT_DAY', 'EXPRESS', 'SURFACE'] as const;
export const ADDRESS_TYPES = ['HOME', 'OFFICE', 'SELLER'] as const;

export type PaymentMode = (typeof PAYMENT_MODES)[number];
export type ServiceType = (typeof SERVICE_TYPES)[number];
export type AddressType = (typeof ADDRESS_TYPES)[number];

export interface Address {
  name: string;
  phone: string;
  email?: string | undefined;
  line1: string;
  line2?: string | undefined;
  city: string;
  state: string;
  pincode: string;
  country: string;
  type: AddressType;
}

export interface Parcel {
  description: string;
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  pieces: number;
  declaredValue: number;
}

export interface Invoice {
  number: string;
  date: string; // ISO date, YYYY-MM-DD
  value: number;
}

export interface NormalizedOrder {
  /** Caller-supplied; unique across the system. */
  orderId: string;
  paymentMode: PaymentMode;
  codAmount?: number | undefined;
  serviceType?: ServiceType | undefined;
  pickup: Address;
  drop: Address;
  /** Defaults to `pickup`. */
  returnTo?: Address | undefined;
  parcel: Parcel;
  invoice: Invoice;
  /** Courier-specific extras; adapters read what they know. */
  metadata?: Record<string, unknown> | undefined;
}

export interface ShipmentResult {
  /** Null when the courier mints no id of its own (UrbaneBolt echoes ours back). */
  courierOrderId?: string | null | undefined;
  awb: string;
  labelUrl?: string | undefined;
  routeCode?: string | undefined;
}

export interface TrackingEvent {
  /** Null for a code the partner's status map does not know; the raw code is kept. */
  status: ShipmentStatus | null;
  courierStatusCode: string;
  courierStatusText: string;
  location?: string | undefined;
  occurredAt: Date;
  raw: unknown;
}

export interface TrackingResult {
  awb: string;
  /** Null for an unrecognised code; the stored status is then left untouched. */
  status: ShipmentStatus | null;
  courierStatusCode: string;
  courierStatusText: string;
  currentLocation?: string | undefined;
  estimatedDeliveryDate?: string | undefined;
  /** Oldest first. */
  events: TrackingEvent[];
}

export interface CancellationResult {
  cancelled: boolean;
  message?: string | undefined;
}

/**
 * An object rather than a bare AWB: partners address shipments differently, and adding a
 * field here is backward-compatible where widening a string parameter would touch every
 * adapter.
 */
export interface ShipmentRef {
  awb: string;
  courierOrderId?: string | undefined;
  orderId: string;
}
