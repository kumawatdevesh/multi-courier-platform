import type { Request, Response } from 'express';

import { toNormalizedOrder } from '../dto/create-order.dto';
import type { BulkOrderRequest } from '../dto/bulk-order.dto';
import { ok } from '../dto/response.dto';
import type { BatchService } from '../services/batch.service';

export class BatchController {
  constructor(private readonly batches: BatchService) {}

  submit = async (req: Request, res: Response): Promise<void> => {
    const { orders } = req.body as BulkOrderRequest;
    const result = await this.batches.submit(
      orders.map((o) => ({ input: toNormalizedOrder(o), courierPartner: o.courier_partner })),
      req.requestId,
    );
    res.status(202).json(ok(result, req.requestId));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    res.json(ok(await this.batches.getBatch(req.params.batchId!), req.requestId));
  };
}
