import type { NextFunction, Request, Response } from 'express';
import type { ZodError, ZodTypeAny } from 'zod';

import { AppError } from '../errors/app-error';
import type { FieldError } from '../errors/error-codes';

/**
 * Reports every issue at once. The body is replaced with the parsed value (defaults,
 * coercions); params are only constrained, since Express owns req.params.
 */
function validate(source: 'body' | 'params', schema: ZodTypeAny, message: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(new AppError('VALIDATION_ERROR', message, { details: toFieldErrors(result.error) }));
      return;
    }
    if (source === 'body') req.body = result.data;
    next();
  };
}

export const validateBody = (schema: ZodTypeAny) =>
  validate('body', schema, 'Request validation failed');

export const validateParams = (schema: ZodTypeAny) =>
  validate('params', schema, 'Invalid path parameter');

function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}
