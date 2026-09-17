import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { NormalizedOrder, ShipmentStatus } from '../couriers/shipment.types';
import { Batch } from './batch.model';
import { TrackingHistory } from './tracking-history.model';

/** RETURNING * yields snake_case columns; maps them onto entity properties. */
export function rowToOrder(row: Record<string, unknown>): Partial<Order> {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    batchId: (row.batch_id as string | null) ?? null,
    courierPartner: row.courier_partner as string,
    status: row.status as ShipmentStatus,
    awb: (row.awb as string | null) ?? null,
    courierOrderId: (row.courier_order_id as string | null) ?? null,
    normalizedPayload: row.normalized_payload as NormalizedOrder,
    attemptCount: row.attempt_count as number,
    leaseUntil: (row.lease_until as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

@Entity('orders')
@Index('idx_orders_status_updated', ['status', 'updatedAt'])
@Index('idx_orders_batch', ['batchId'])
@Index('idx_orders_lease', ['status', 'leaseUntil'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The consumer's id and the idempotency anchor: duplicates conflict here, not in code. */
  @Index('idx_orders_order_id', { unique: true })
  @Column({ name: 'order_id', type: 'text' })
  orderId!: string;

  /** Null for single creates. */
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => Batch, (batch) => batch.orders, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch!: Batch | null;

  /** Registry key. text, not enum — a new partner must not need a migration. */
  @Column({ name: 'courier_partner', type: 'text' })
  courierPartner!: string;

  @Column({ name: 'courier_order_id', type: 'text', nullable: true })
  courierOrderId!: string | null;

  @Column({ name: 'label_url', type: 'text', nullable: true })
  labelUrl!: string | null;

  @Column({ name: 'route_code', type: 'text', nullable: true })
  routeCode!: string | null;

  /** text: UrbaneBolt AWBs are numeric, other partners' are alphanumeric. */
  @Index('idx_orders_awb')
  @Column({ type: 'text', nullable: true })
  awb!: string | null;

  /** varchar, not enum: adding a status must not need ALTER TYPE. */
  @Column({ type: 'varchar', length: 32, default: 'PENDING' })
  status!: ShipmentStatus;

  @Column({ name: 'normalized_payload', type: 'jsonb' })
  normalizedPayload!: NormalizedOrder;

  /** The create call's raw request/response. Track and cancel are audited elsewhere. */
  @Column({ name: 'request_payload', type: 'jsonb', nullable: true })
  requestPayload!: unknown;

  @Column({ name: 'response_payload', type: 'jsonb', nullable: true })
  responsePayload!: unknown;

  @Column({ name: 'last_error', type: 'jsonb', nullable: true })
  lastError!: Record<string, unknown> | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  /** While PROCESSING: the moment this row may be re-claimed if its worker went silent. */
  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  @OneToMany(() => TrackingHistory, (event) => event.order)
  trackingHistory!: TrackingHistory[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
