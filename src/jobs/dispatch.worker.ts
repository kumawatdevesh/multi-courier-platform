import type { DataSource, Repository } from 'typeorm';

import { findCourier } from '../couriers/courier.registry';
import { ERROR_MESSAGES } from '../errors/error-codes';
import { logger } from '../lib/logger';
import { Order, rowToOrder } from '../models/order.model';
import type { BatchService } from '../services/batch.service';
import type { OrderService } from '../services/order.service';

export interface WorkerOptions {
  pollMs: number;
  batchSize: number;
  concurrencyPerPartner: number;
  /** How long a claim is owned before a silent worker's rows may be taken over. */
  leaseMs: number;
}

/**
 * Drains PENDING orders. The orders table is the queue; SKIP LOCKED lets workers share it.
 * Ownership is a lease, not a lock: a claim sets lease_until, the dispatch heartbeats it,
 * and a lapsed lease means the worker died mid-call.
 */
export class DispatchWorker {
  private readonly orders: Repository<Order>;
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> | null = null;
  private stopped = false;

  constructor(
    dataSource: DataSource,
    private readonly orderService: OrderService,
    private readonly batchService: BatchService,
    private readonly opts: WorkerOptions,
  ) {
    this.orders = dataSource.getRepository(Order);
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

  /** One pass; returns rows claimed (fresh + reclaimed). */
  async runOnce(): Promise<number> {
    const claimed = [...(await this.reclaimExpired()), ...(await this.claim())];
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

  /** Takes up to batchSize PENDING rows, marking them PROCESSING with a fresh lease. */
  private claim(): Promise<Order[]> {
    return this.take(`status = 'PENDING'`);
  }

  /**
   * Takes over PROCESSING rows whose lease lapsed — their worker stopped heartbeating, i.e.
   * died mid-call. The courier call ran outside any lock (at-most-once), so we cannot know
   * whether it went through. Re-dispatch only where the partner rejects a duplicate
   * reference, so the worst case is a DUPLICATE_ORDER failure rather than a second
   * shipment; otherwise mark it FAILED for a person to confirm with the courier.
   */
  private async reclaimExpired(): Promise<Order[]> {
    const expired = await this.take(`status = 'PROCESSING' AND lease_until < now()`);
    if (expired.length === 0) return [];

    const retry: Order[] = [];
    const failedBatches: string[] = [];
    for (const order of expired) {
      const adapter = findCourier(order.courierPartner);
      if (adapter?.idempotentOnReference) {
        logger.warn(
          { orderId: order.id, courierPartner: order.courierPartner },
          'lease lapsed; re-dispatching',
        );
        retry.push(order);
        continue;
      }
      logger.warn(
        { orderId: order.id, courierPartner: order.courierPartner },
        'lease lapsed; partner is not idempotent, marking FAILED',
      );
      await this.orders
        .createQueryBuilder()
        .update()
        .set({
          status: 'FAILED',
          leaseUntil: null,
          lastError: () =>
            `jsonb_build_object('code', 'DISPATCH_INTERRUPTED', 'message', :msg::text, 'at', now())`,
        })
        .setParameter('msg', ERROR_MESSAGES.DISPATCH_INTERRUPTED)
        .where('id = :id', { id: order.id })
        .execute();
      if (order.batchId) failedBatches.push(order.batchId);
    }
    // A batch whose last in-flight row just failed here must still complete.
    await this.batchService.closeCompleted(failedBatches);
    return retry;
  }

  /** The claim itself: lock, mark PROCESSING, set the lease, release — one statement. */
  private async take(where: string): Promise<Order[]> {
    const { raw } = await this.orders
      .createQueryBuilder()
      .update()
      .set({
        status: 'PROCESSING',
        leaseUntil: () => `now() + (${this.opts.leaseMs} * interval '1 ms')`,
      })
      .where(
        `id IN (SELECT id FROM orders WHERE ${where}
                ORDER BY created_at LIMIT :limit FOR UPDATE SKIP LOCKED)`,
        { limit: this.opts.batchSize },
      )
      .returning('*')
      .execute();
    return (raw as Record<string, unknown>[]).map((row) => this.orders.create(rowToOrder(row)));
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
