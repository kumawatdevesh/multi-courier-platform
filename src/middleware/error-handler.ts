import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../errors/app-error';
import { CourierError } from '../errors/courier-error';
import type { ErrorResponse } from '../errors/error-codes';
import { logger } from '../lib/logger';

interface BodyParserError {
  type?: string;
  status?: number;
}

/** Maps body-parser failures (tagged with `type`) into the taxonomy; anything else is a 500. */
function normalize(error: unknown): AppError {
  if (error instanceof AppError) return error;

  switch ((error as BodyParserError).type) {
    case 'entity.parse.failed':
      return new AppError('VALIDATION_ERROR', 'Request body is not valid JSON', {
        details: [{ field: '(body)', message: 'malformed JSON' }],
        cause: error,
      });
    case 'entity.too.large':
      return new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large', { cause: error });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError('VALIDATION_ERROR', 'Unsupported request encoding', {
        details: [{ field: '(headers)', message: 'unsupported Content-Type encoding' }],
        cause: error,
      });
    default:
      return new AppError('INTERNAL_ERROR', 'An unexpected error occurred', { cause: error });
  }
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError = normalize(error);
  const requestId = req.requestId ?? 'unassigned';

  logger.error(
    {
      requestId,
      orderId: req.params.orderId,
      courierPartner: error instanceof CourierError ? error.courierPartner : undefined,
      errorCode: appError.code,
      errorType: appError.name,
      httpStatus: appError.httpStatus,
      method: req.method,
      path: req.originalUrl,
      context: appError.context,
      courierResponse: error instanceof CourierError ? error.rawResponse : undefined,
      stack: appError.httpStatus >= 500 ? appError.stack : undefined,
      cause:
        appError.cause instanceof Error
          ? {
              name: appError.cause.name,
              message: appError.cause.message,
              stack: appError.cause.stack,
            }
          : appError.cause,
    },
    appError.message,
  );

  const body: ErrorResponse = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
      requestId,
      timestamp: new Date().toISOString(),
    },
  };

  res.status(appError.httpStatus).json(body);
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
}
