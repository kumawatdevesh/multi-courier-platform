import 'reflect-metadata';
import type { Server } from 'node:http';
import express, { type Express } from 'express';

import { config } from './config';
import { loadCouriers } from './couriers/courier.loader';
import { listCourierKeys } from './couriers/courier.registry';
import { AppDataSource, initDatabase } from './db/data-source';
import { DispatchWorker } from './jobs/dispatch.worker';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { buildOrderRoutes } from './routes/order.routes';
import { BatchService } from './services/batch.service';
import { OrderService } from './services/order.service';

export interface App {
  app: Express;
  worker: DispatchWorker;
}

export async function buildApp(): Promise<App> {
  const dataSource = await initDatabase();
  await loadCouriers();

  const orderService = new OrderService(dataSource);
  const batchService = new BatchService(dataSource);
  const worker = new DispatchWorker(dataSource, orderService, batchService, config.worker);

  const app = express();

  // Before the body parser, so a parse failure still carries a correlation id.
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      database: AppDataSource.isInitialized ? 'up' : 'down',
      couriers: listCourierKeys(),
    });
  });

  app.use('/api/v1', buildOrderRoutes(orderService, batchService));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, worker };
}

function installProcessHandlers(server: Server, worker: DispatchWorker): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception, shutting down');
    process.exit(1);
  });

  // Stop accepting, let in-flight courier calls and the current worker tick finish, close the pool.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      server.close(() => {
        void worker
          .stop()
          .then(() => AppDataSource.destroy())
          .finally(() => process.exit(0));
      });
    });
  }
}

async function main(): Promise<void> {
  const { app, worker } = await buildApp();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'multi-courier platform listening');
  });
  if (config.worker.enabled) worker.start();
  installProcessHandlers(server, worker);
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ err: error }, 'failed to start');
    process.exit(1);
  });
}
