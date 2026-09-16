import type { AuditEntry, CourierContext } from '../courier.interface';
import type { Order } from '../../models/order.model';

/** Keeps the last exchange an adapter reports — the one that decided the outcome. */
export class AuditTrail {
  private last: AuditEntry | undefined;
  private count = 0;

  readonly capture = (entry: AuditEntry): void => {
    this.last = entry;
    this.count += 1;
  };

  get attempts(): number {
    return this.count;
  }

  get durationMs(): number | undefined {
    return this.last?.durationMs;
  }

  toOrderFields(): Pick<Order, 'requestPayload' | 'responsePayload' | 'attemptCount'> {
    return {
      requestPayload: this.last?.request ?? null,
      responsePayload: this.last?.response ?? null,
      attemptCount: this.count,
    };
  }
}

export function createCourierContext(
  requestId: string,
  orderId?: string,
): { ctx: CourierContext; audit: AuditTrail } {
  const audit = new AuditTrail();
  return { ctx: { requestId, orderId, audit: audit.capture }, audit };
}
