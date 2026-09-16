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

@Entity('orders')
@Index('idx_orders_status_updated', ['status', 'updatedAt'])
@Index('idx_orders_batch', ['batchId'])
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

  @OneToMany(() => TrackingHistory, (event) => event.order)
  trackingHistory!: TrackingHistory[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
