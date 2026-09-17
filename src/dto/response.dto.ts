import type { Order } from '../models/order.model';
import type { TrackingHistory } from '../models/tracking-history.model';

export interface SuccessResponse<T> {
  success: true;
  data: T;
  requestId: string;
}

export function ok<T>(data: T, requestId: string): SuccessResponse<T> {
  return { success: true, data, requestId };
}

export interface OrderView {
  id: string;
  orderId: string;
  courierPartner: string;
  courierOrderId: string | null;
  awb: string | null;
  status: string;
  labelUrl?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

/** Omits the audit columns — response_payload is where the courier's raw error text lives. */
export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    orderId: order.orderId,
    courierPartner: order.courierPartner,
    courierOrderId: order.courierOrderId,
    awb: order.awb,
    status: order.status,
    labelUrl: order.labelUrl ?? undefined,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export interface TrackingEventView {
  status: string | null;
  courierStatusCode: string;
  courierStatusText: string;
  location: string;
  occurredAt: string;
}

export function toTrackingView(
  order: Order,
  events: TrackingHistory[],
): OrderView & { events: TrackingEventView[] } {
  return {
    ...toOrderView(order),
    events: events.map((event): TrackingEventView => ({
      status: event.status,
      courierStatusCode: event.courierStatusCode,
      courierStatusText: event.courierStatusText,
      location: event.location,
      occurredAt: event.statusTimestamp.toISOString(),
    })),
  };
}
