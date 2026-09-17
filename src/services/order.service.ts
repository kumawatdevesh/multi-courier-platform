import type { DataSource, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { CourierAdapter } from '../couriers/courier.interface';
import { findCourier, listCourierKeys } from '../couriers/courier.registry';
import { createCourierContext } from '../couriers/shared/audit-trail';
import {
  TERMINAL_STATUSES,
  type CancellationResult,
  type NormalizedOrder,
  type ShipmentRef,
  type TrackingResult,
} from '../couriers/shipment.types';
import { AppError } from '../errors/app-error';
import { CourierError } from '../errors/courier-error';
import { logger } from '../lib/logger';
import { Order } from '../models/order.model';
import { TrackingHistory } from '../models/tracking-history.model';

/** Courier-agnostic: no partner name, no switch. Adding a courier changes nothing here. */
export class OrderService {
  private readonly orders: Repository<Order>;
  private readonly tracking: Repository<TrackingHistory>;

  constructor(dataSource: DataSource) {
    this.orders = dataSource.getRepository(Order);
    this.tracking = dataSource.getRepository(TrackingHistory);
  }

  /**
   * resolve courier → INSERT → dispatch inline. Inserted as PROCESSING, not PENDING: the row
   * is in flight from the start, and PENDING is what the bulk worker claims.
   */
  async createOrder(
    input: NormalizedOrder,
    courierPartner: string,
    requestId: string,
  ): Promise<Order> {
    const adapter = this.adapterForRequest(courierPartner);
    const order = await this.insertOrder(input, adapter.key, 'PROCESSING');
    return this.dispatch(order, requestId);
  }

  /** Sends one order to its courier and persists the outcome. Shared by create and the worker. */
  async dispatch(order: Order, requestId: string): Promise<Order> {
    const { ctx, audit } = createCourierContext(requestId, order.id);

    try {
      // Inside the try so a partner disabled after submit persists FAILED like any other failure.
      const adapter = this.adapterForStored(order);
      const result = await adapter.createShipment(order.normalizedPayload, ctx);
      await this.patch(order, {
        status: 'CREATED',
        awb: result.awb,
        courierOrderId: result.courierOrderId ?? null,
        labelUrl: result.labelUrl ?? null,
        routeCode: result.routeCode ?? null,
        lastError: null,
        ...audit.toOrderFields(),
      });
      logger.info(
        {
          requestId,
          orderId: order.id,
          courierPartner: order.courierPartner,
          awb: result.awb,
          durationMs: audit.durationMs,
        },
        'shipment created',
      );
      return order;
    } catch (error) {
      // Persist the failure for reconciliation before it propagates.
      const appError = error instanceof AppError ? error : undefined;
      await this.patch(order, {
        status: 'FAILED',
        lastError:
          error instanceof CourierError
            ? error.toPersisted()
            : {
                code: appError?.code ?? 'INTERNAL_ERROR',
                message: error instanceof Error ? error.message : String(error),
                at: new Date().toISOString(),
              },
        ...audit.toOrderFields(),
      });
      logger.error(
        {
          requestId,
          orderId: order.id,
          courierPartner: order.courierPartner,
          errorCode: appError?.code ?? 'INTERNAL_ERROR',
          errorType: error instanceof Error ? error.name : typeof error,
          attempts: audit.attempts,
          durationMs: audit.durationMs,
          stack: appError ? undefined : (error as Error)?.stack,
        },
        'shipment creation failed',
      );
      throw error;
    }
  }

  async getOrder(id: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id } });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', `No order with id "${id}"`);
    }
    return order;
  }

  async trackOrder(
    id: string,
    requestId: string,
  ): Promise<{ order: Order; events: TrackingHistory[] }> {
    const order = await this.getOrder(id);
    const adapter = this.adapterForStored(order);
    const { ctx } = createCourierContext(requestId, order.id);

    const result = await adapter.trackShipment(this.refFor(order), ctx);

    // Null status = unrecognised code; leave the stored status alone rather than guess.
    await Promise.all([
      this.appendTrackingEvents(order, result),
      result.status && result.status !== order.status
        ? this.patch(order, { status: result.status })
        : undefined,
    ]);

    const events = await this.tracking.find({
      where: { orderId: order.id },
      order: { statusTimestamp: 'ASC' },
    });
    return { order, events };
  }

  async cancelOrder(id: string, requestId: string): Promise<CancellationResult> {
    const order = await this.getOrder(id);

    if (order.status === 'CANCELLED') {
      return { cancelled: true, message: 'Order is already cancelled' };
    }
    if (TERMINAL_STATUSES.has(order.status)) {
      throw new AppError(
        'INVALID_ORDER_STATE',
        `A ${order.status.toLowerCase()} shipment cannot be cancelled`,
        {
          context: { orderId: order.id, status: order.status },
        },
      );
    }

    const adapter = this.adapterForStored(order);
    const { ctx } = createCourierContext(requestId, order.id);
    const result = await adapter.cancelShipment(this.refFor(order), ctx);

    await this.patch(order, { status: 'CANCELLED' });
    logger.info(
      { requestId, orderId: order.id, courierPartner: order.courierPartner },
      'shipment cancelled',
    );
    return result;
  }

  // --- helpers ---------------------------------------------------------------

  /** Key from the request: unknown is the caller's error (400). */
  private adapterForRequest(courierPartner: string): CourierAdapter {
    const adapter = findCourier(courierPartner);
    if (!adapter) {
      throw new AppError('UNKNOWN_COURIER', `Unsupported courier_partner "${courierPartner}"`, {
        details: [
          {
            field: 'courier_partner',
            message: `Supported couriers: ${listCourierKeys().join(', ') || 'none configured'}`,
            rejectedValue: courierPartner,
          },
        ],
      });
    }
    return adapter;
  }

  /** Key from the database: unknown means we disabled the partner (503), not the caller's fault. */
  private adapterForStored(order: Order): CourierAdapter {
    const adapter = findCourier(order.courierPartner);
    if (!adapter) {
      throw new AppError(
        'COURIER_UNAVAILABLE',
        `Courier partner "${order.courierPartner}" is not configured on this instance`,
        {
          context: { orderId: order.id, courierPartner: order.courierPartner },
          retryable: false,
        },
      );
    }
    return adapter;
  }

  /**
   * Duplicates are rejected by the unique index, not a prior SELECT, so concurrent requests
   * cannot both pass. insert() rather than save(): save() wraps one INSERT in a transaction.
   */
  private async insertOrder(
    input: NormalizedOrder,
    courierPartner: string,
    status: 'PENDING' | 'PROCESSING',
    batchId: string | null = null,
  ): Promise<Order> {
    const fields = {
      orderId: input.orderId,
      batchId,
      courierPartner,
      status,
      normalizedPayload: input,
      attemptCount: 0,
    };
    try {
      const { generatedMaps } = await this.orders.insert(fields as QueryDeepPartialEntity<Order>);
      return this.orders.create({ ...fields, ...generatedMaps[0] });
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'idx_orders_order_id') {
        throw new AppError(
          'DUPLICATE_ORDER',
          `An order with order_id "${input.orderId}" already exists`,
          {
            details: [
              { field: 'order_id', message: 'already submitted', rejectedValue: input.orderId },
            ],
          },
        );
      }
      throw error;
    }
  }

  /**
   * UPDATE … RETURNING merged onto the entity, so nothing re-reads a row it just wrote.
   * The cast: QueryDeepPartialEntity rejects plain objects for jsonb columns.
   */
  private async patch(order: Order, fields: Partial<Order>): Promise<Order> {
    await this.orders
      .createQueryBuilder()
      .update()
      .set(fields as QueryDeepPartialEntity<Order>)
      .whereEntity(order)
      .returning('*')
      .updateEntity(true)
      .execute();
    return order;
  }

  private refFor(order: Order): ShipmentRef {
    if (!order.awb) {
      throw new AppError(
        'INVALID_ORDER_STATE',
        `Order has no shipment at the courier (status ${order.status})`,
        {
          context: { orderId: order.id, status: order.status },
        },
      );
    }
    return {
      awb: order.awb,
      courierOrderId: order.courierOrderId ?? undefined,
      orderId: order.orderId,
    };
  }

  private async appendTrackingEvents(order: Order, result: TrackingResult): Promise<void> {
    if (result.events.length === 0) return;

    await this.tracking
      .createQueryBuilder()
      .insert()
      .into(TrackingHistory)
      .values(
        result.events.map((event) => ({
          orderId: order.id,
          status: event.status,
          courierStatusCode: event.courierStatusCode,
          courierStatusText: event.courierStatusText,
          location: event.location ?? null,
          statusTimestamp: event.occurredAt,
          rawPayload: event.raw,
        })) as QueryDeepPartialEntity<TrackingHistory>[],
      )
      .orIgnore() // ON CONFLICT DO NOTHING — re-polling is idempotent
      .execute();
  }
}
