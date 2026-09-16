import { z } from 'zod';

/** Rejected before the service so a malformed id is a 400, not a Postgres 500. */
export const orderIdParamsSchema = z.object({
  orderId: z.string().uuid('must be a UUID'),
});
