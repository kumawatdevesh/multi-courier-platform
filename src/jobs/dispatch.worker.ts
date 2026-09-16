import type { DataSource, Repository } from 'typeorm';

import { logger } from '../lib/logger';
import { Order } from '../models/order.model';
import type { BatchService } from '../services/batch.service';
import type { OrderService } from '../services/order.service';

export interface WorkerOptions {
  pollMs: number;
  batchSize: number;
  concurrencyPerPartner: number;
}

/** Drains PENDING orders. The orders table is the queue; SKIP LOCKED lets workers share it. */
export class DispatchWorker {
  private readonly orders: Repository<Order>;
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private dataSource: DataSource,
    private readonly orderService: OrderService,
    private readonly batchService: BatchService,
    private readonly opts: WorkerOptions,
  ) {
    this.orders = this.dataSource.getRepository(Order);
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      this.tick = this.runOnce()
        .then(() => undefined)
        .catch((error) => {
          logger.error({ err: error }, 'dispatch worker tick failed');
        });
      await this.tick;
      this.tick = null;
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.pollMs);
    };
    void loop();
    logger.info(this.opts, 'dispatch worker started');
  }

  /** Waits for the in-flight tick so no claimed row is abandoned. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.tick;
  }

  /** One pass; returns rows claimed. */
  async runOnce(): Promise<number> {
    const claimed = await this.claim();
    if (claimed.length === 0) return 0;

    const batchIds = claimed.flatMap((o) => (o.batchId ? [o.batchId] : []));
    await this.batchService.markProcessing(batchIds);

    const byPartner = new Map<string, Order[]>();
    for (const order of claimed) {
      byPartner.set(order.courierPartner, [...(byPartner.get(order.courierPartner) ?? []), order]);
    }
    await Promise.all(
      [...byPartner.values()].map((group) =>
        runBounded(group, this.opts.concurrencyPerPartner, (order) => this.dispatchOne(order)),
      ),
    );

    await this.batchService.closeCompleted(batchIds);
    return claimed.length;
  }

  /**
   * A row left PROCESSING by a crash is never re-claimed: the courier may already have
   * issued an AWB, so it belongs to reconciliation, not a retry.
   */
  private async claim(): Promise<Order[]> {
    const { raw } = await this.orders
      .createQueryBuilder()
      .update()
      .set({ status: 'PROCESSING' })
      .where(
        `id IN (SELECT id FROM orders WHERE status = 'PENDING'
                ORDER BY created_at LIMIT :limit FOR UPDATE SKIP LOCKED)`,
        { limit: this.opts.batchSize },
      )
      .returning('*')
      .execute();
    return (raw as Record<string, unknown>[]).map((row) => this.orders.create(fromRow(row)));
  }

  private async dispatchOne(order: Order): Promise<void> {
    const requestId = `worker-${order.batchId ?? 'single'}-${order.id}`;
    try {
      await this.orderService.dispatch(order, requestId);
    } catch {
      // dispatch() already persisted FAILED and logged; one bad order must not stop the chunk.
    }
  }
}

async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await fn(next);
    }
  });
  await Promise.all(lanes);
}

/** RETURNING * yields snake_case columns. */
function fromRow(row: Record<string, unknown>): Partial<Order> {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    batchId: (row.batch_id as string | null) ?? null,
    courierPartner: row.courier_partner as string,
    status: row.status as Order['status'],
    awb: (row.awb as string | null) ?? null,
    normalizedPayload: row.normalized_payload as Order['normalizedPayload'],
    attemptCount: row.attempt_count as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}
