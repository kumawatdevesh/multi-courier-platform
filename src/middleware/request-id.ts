import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/** Correlation id: reuses an inbound X-Request-Id so an upstream trace carries through. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  req.requestId = inbound && inbound.length <= 128 ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
