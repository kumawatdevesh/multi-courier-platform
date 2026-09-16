import type { Request, Response } from 'express';

import { listCouriers } from '../couriers/courier.registry';
import { toNormalizedOrder, type CreateOrderRequest } from '../dto/create-order.dto';
import { ok, toOrderView, toTrackingView } from '../dto/response.dto';
import type { OrderService } from '../services/order.service';

/** HTTP only. No try/catch: asyncRoute forwards every throw to the error middleware. */
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  createOrder = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateOrderRequest;

    const order = await this.orders.createOrder(
      toNormalizedOrder(body),
      body.courier_partner,
      req.requestId,
    );

    res.status(201).json(ok(toOrderView(order), req.requestId));
  };

  getOrder = async (req: Request, res: Response): Promise<void> => {
    const order = await this.orders.getOrder(req.params.orderId!);
    res.json(ok(toOrderView(order), req.requestId));
  };

  trackOrder = async (req: Request, res: Response): Promise<void> => {
    const { order, events } = await this.orders.trackOrder(req.params.orderId!, req.requestId);
    res.json(ok(toTrackingView(order, events), req.requestId));
  };

  cancelOrder = async (req: Request, res: Response): Promise<void> => {
    const result = await this.orders.cancelOrder(req.params.orderId!, req.requestId);
    res.json(ok(result, req.requestId));
  };

  listCouriers = (req: Request, res: Response): void => {
    res.json(ok({ couriers: listCouriers() }, req.requestId));
  };
}
