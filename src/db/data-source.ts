import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { config } from '../config';
import { Batch } from '../models/batch.model';
import { Order } from '../models/order.model';
import { TrackingHistory } from '../models/tracking-history.model';

/** synchronize is always false; schema changes go through db/migrations. */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: config.databaseUrl,
  entities: [Order, TrackingHistory, Batch],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  synchronize: false,
  // TypeORM's logger bypasses pino and reports expected unique violations as errors.
  logging: config.logLevel === 'debug' ? ['query', 'error'] : false,
  poolSize: config.dbPoolSize,
  extra: {
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  },
});

export async function initDatabase(): Promise<DataSource> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  return AppDataSource;
}
