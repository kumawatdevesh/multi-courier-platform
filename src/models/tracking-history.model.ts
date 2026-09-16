import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import type { ShipmentStatus } from '../couriers/shipment.types';
import { Order } from './order.model';

/**
 * Append-only scan history. The unique constraint is what makes re-polling safe: the
 * courier returns its whole scan list each time and writers use .orIgnore().
 */
@Entity('tracking_history')
@Unique('uq_tracking_event', ['orderId', 'courierStatusCode', 'statusTimestamp'])
@Index('idx_tracking_order_time', ['orderId', 'statusTimestamp'])
export class TrackingHistory {
  /** bigint reads back as a string in JS. */
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.trackingHistory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  /** Null when the partner's status map does not know the code. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  status!: ShipmentStatus | null;

  /** The vendor's raw code — the record when the map is behind, and the dedupe key. */
  @Column({ name: 'courier_status_code', type: 'text' })
  courierStatusCode!: string;

  @Column({ name: 'courier_status_text', type: 'text', nullable: true })
  courierStatusText!: string | null;

  @Column({ type: 'text', nullable: true })
  location!: string | null;

  /** When the courier says the scan happened. */
  @Column({ name: 'status_timestamp', type: 'timestamptz' })
  statusTimestamp!: Date;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload!: unknown;

  /** When we ingested it; couriers backfill scans late, so this differs from statusTimestamp. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
