import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Order } from './order.model';

export const BATCH_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** Per-order outcomes live on the orders themselves. */
@Entity('batches')
export class Batch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'int' })
  total!: number;

  /** total minus duplicates. */
  @Column({ type: 'int', default: 0 })
  accepted!: number;

  @Column({ type: 'varchar', length: 16, default: 'QUEUED' })
  status!: BatchStatus;

  @OneToMany(() => Order, (order) => order.batch)
  orders!: Order[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
