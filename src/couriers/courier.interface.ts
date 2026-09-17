import type {
  CancellationResult,
  NormalizedOrder,
  ShipmentRef,
  ShipmentResult,
  TrackingResult,
} from './shipment.types';

export interface AuditEntry {
  request: unknown;
  response: unknown;
  durationMs: number;
}

export interface CourierContext {
  requestId: string;
  orderId?: string | undefined;
  /** Raw request/response sink; the service persists what lands here. */
  audit: (entry: AuditEntry) => void;
}

/**
 * Implemented at `couriers/<key>/<key>.adapter.ts` (default-export a CourierFactory) and
 * discovered by courier.loader.ts at boot. Adapters map payloads only — timeouts, retry,
 * token caching and 401-replay come from `couriers/shared/`. Auth is not a method: an
 * adapter that needs a token gives its CourierHttpClient a TokenCache.
 */
export interface CourierAdapter {
  /** The `courier_partner` value on the wire, e.g. "urbanebolt". */
  readonly key: string;
  readonly displayName: string;

  /**
   * True if the partner rejects a second createShipment for an orderId it has already
   * shipped. Decides whether a dispatch interrupted by a crash may be retried automatically.
   */
  readonly idempotentOnReference: boolean;

  createShipment(order: NormalizedOrder, ctx: CourierContext): Promise<ShipmentResult>;
  trackShipment(ref: ShipmentRef, ctx: CourierContext): Promise<TrackingResult>;

  cancelShipment(ref: ShipmentRef, ctx: CourierContext): Promise<CancellationResult>;
}

export type CourierFactory = (config: CourierConfig) => CourierAdapter;

export interface CourierConfig {
  key: string;
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  /** Every other COURIER_<KEY>_* variable, camel-cased. */
  credentials: Record<string, string>;
}
