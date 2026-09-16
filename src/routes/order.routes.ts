import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { BatchController } from '../controllers/batch.controller';
import { OrderController } from '../controllers/order.controller';
import { batchIdParamsSchema, bulkOrderSchema } from '../dto/bulk-order.dto';
import { createOrderSchema } from '../dto/create-order.dto';
import { orderIdParamsSchema } from '../dto/order-id.dto';
import { validateBody, validateParams } from '../middleware/validate';
import type { BatchService } from '../services/batch.service';
import type { OrderService } from '../services/order.service';

/** Express 4 ignores rejected promises; this forwards them to the error middleware. */
function asyncRoute(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function buildOrderRoutes(service: OrderService, batchService: BatchService): Router {
  const router = Router();
  const controller = new OrderController(service);
  const batches = new BatchController(batchService);

  router.get('/couriers', asyncRoute(controller.listCouriers));

  router.post('/orders/bulk', validateBody(bulkOrderSchema), asyncRoute(batches.submit));
  router.get('/batches/:batchId', validateParams(batchIdParamsSchema), asyncRoute(batches.get));

  router.post('/orders', validateBody(createOrderSchema), asyncRoute(controller.createOrder));

  const orderId = validateParams(orderIdParamsSchema);
  router.get('/orders/:orderId', orderId, asyncRoute(controller.getOrder));
  router.get('/orders/:orderId/track', orderId, asyncRoute(controller.trackOrder));
  router.post('/orders/:orderId/cancel', orderId, asyncRoute(controller.cancelOrder));

  return router;
}
