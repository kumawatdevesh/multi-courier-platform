import { z } from 'zod';

import { createOrderSchema } from './create-order.dto';

export const BULK_MAX = 100;

export const bulkOrderSchema = z.object({
  orders: z.array(createOrderSchema).min(1).max(BULK_MAX),
});

export type BulkOrderRequest = z.infer<typeof bulkOrderSchema>;

export const batchIdParamsSchema = z.object({
  batchId: z.string().uuid('must be a UUID'),
});
