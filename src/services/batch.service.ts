import { Not, type DataSource, type Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { findCourier, listCourierKeys } from '../couriers/courier.registry';
import type { NormalizedOrder } from '../couriers/shipment.types';
import { AppError } from '../errors/app-error';
import type { FieldError } from '../errors/error-codes';
import { logger } from '../lib/logger';
import { Batch } from '../models/batch.model';
import { Order } from '../models/order.model';

export interface BulkSubmission {
  batchId: string;
  total: number;
  accepted: number;
  duplicates: Array<{ orderId: string; reason: 'DUPLICATE_ORDER' }>;
}

export interface BatchView {
  batchId: string;
  status: Batch['status'];
  total: number;
  accepted: number;
  succeeded: number;
  failed: number;
  pending: number;
  createdAt: string;
  completedAt: string | null;
  orders: Array<{
    orderId: string;
    status: string;
    awb: string | null;
    error: { code: string; message: string } | null;
  }>;
}

export class BatchService {
  private readonly batches: Repository<Batch>;
  private readonly orders: Repository<Order>;

  constructor(private readonly dataSource: DataSource) {
    this.batches = dataSource.getRepository(Batch);
    this.orders = dataSource.getRepository(Order);
  }

  /** Inserts the batch and its orders as PENDING in one transaction; the worker does the rest. */
  async submit(
    orders: Array<{ input: NormalizedOrder; courierPartner: string }>,
    requestId: string,
  ): Promise<BulkSubmission> {
    this.assertCouriersKnown(orders);

    return this.dataSource.transaction(async (tx) => {
      const batch = await tx.getRepository(Batch).save({ total: orders.length, accepted: 0 });

      const rows = orders.map(({ input, courierPartner }) => ({
        orderId: input.orderId,
        batchId: batch.id,
        courierPartner: findCourier(courierPartner)!.key,
        status: 'PENDING' as const,
        normalizedPayload: input,
        attemptCount: 0,
      }));

      const { raw } = await tx
        .getRepository(Order)
        .createQueryBuilder()
        .insert()
        .into(Order)
        .values(rows as QueryDeepPartialEntity<Order>[])
        .orIgnore()
        .returning('order_id')
        .execute();

      // A repeated order_id inside the payload inserts once; only its first occurrence counts.
      const inserted = new Set((raw as Array<{ order_id: string }>).map((r) => r.order_id));
      const seen = new Set<string>();
      const duplicates: BulkSubmission['duplicates'] = [];
      for (const { input } of orders) {
        if (inserted.has(input.orderId) && !seen.has(input.orderId)) seen.add(input.orderId);
        else duplicates.push({ orderId: input.orderId, reason: 'DUPLICATE_ORDER' });
      }

      await tx.getRepository(Batch).update(batch.id, { accepted: inserted.size });

      logger.info(
        { requestId, batchId: batch.id, total: orders.length, accepted: inserted.size },
        'bulk batch accepted',
      );
      return { batchId: batch.id, total: orders.length, accepted: inserted.size, duplicates };
    });
  }

  async getBatch(id: string): Promise<BatchView> {
    const batch = await this.batches.findOne({ where: { id } });
    if (!batch) {
      throw new AppError('NOT_FOUND', `No batch with id "${id}"`);
    }

    const orders = await this.orders.find({
      where: { batchId: id },
      order: { createdAt: 'ASC' },
      select: ['id', 'orderId', 'status', 'awb', 'lastError', 'createdAt'],
    });

    const count = (pred: (o: Order) => boolean) => orders.filter(pred).length;
    return {
      batchId: batch.id,
      status: batch.status,
      total: batch.total,
      accepted: batch.accepted,
      succeeded: count(
        (o) => o.status !== 'PENDING' && o.status !== 'PROCESSING' && o.status !== 'FAILED',
      ),
      failed: count((o) => o.status === 'FAILED'),
      pending: count((o) => o.status === 'PENDING' || o.status === 'PROCESSING'),
      createdAt: batch.createdAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() ?? null,
      orders: orders.map((o) => ({
        orderId: o.orderId,
        status: o.status,
        awb: o.awb,
        error: o.lastError
          ? { code: String(o.lastError.code), message: String(o.lastError.message) }
          : null,
      })),
    };
  }

  async markProcessing(batchIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(batchIds)];
    if (ids.length === 0) return;
    await this.batches
      .createQueryBuilder()
      .update()
      .set({ status: 'PROCESSING' })
      .where('id IN (:...ids) AND status = :queued', { ids, queued: 'QUEUED' })
      .execute();
  }

  /** Any batch with nothing left in flight is COMPLETED. */
  async closeCompleted(batchIds: Iterable<string>): Promise<void> {
    for (const batchId of new Set(batchIds)) {
      const inFlight = await this.orders.count({
        where: [
          { batchId, status: 'PENDING' },
          { batchId, status: 'PROCESSING' },
        ],
      });
      if (inFlight === 0) {
        await this.batches.update(
          { id: batchId, status: Not('COMPLETED') },
          { status: 'COMPLETED', completedAt: new Date() },
        );
      }
    }
  }

  private assertCouriersKnown(orders: Array<{ courierPartner: string }>): void {
    const details: FieldError[] = orders.flatMap(({ courierPartner }, i) =>
      findCourier(courierPartner)
        ? []
        : [
            {
              field: `orders.${i}.courier_partner`,
              message: `Supported couriers: ${listCourierKeys().join(', ')}`,
              rejectedValue: courierPartner,
            },
          ],
    );
    if (details.length > 0) {
      throw new AppError(
        'UNKNOWN_COURIER',
        'One or more orders name an unsupported courier_partner',
        { details },
      );
    }
  }
}
