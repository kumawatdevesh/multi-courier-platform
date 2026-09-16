import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/errors/app-error';
import { CourierError } from '../../src/errors/courier-error';
import { errorHandler } from '../../src/middleware/error-handler';

function run(error: unknown, req: Record<string, unknown> = {}) {
  const json = vi.fn((_body: unknown) => undefined);
  const status = vi.fn((_code: number) => ({ json }));
  const res = { status } as unknown as Response;
  errorHandler(
    error,
    {
      requestId: 'rid',
      params: {},
      body: {},
      method: 'GET',
      originalUrl: '/x',
      ...req,
    } as unknown as Request,
    res,
    vi.fn(),
  );
  return {
    status: status.mock.calls[0]![0],
    body: json.mock.calls[0]![0] as { success: boolean; error: Record<string, unknown> },
  };
}

describe('errorHandler', () => {
  it('renders an AppError with its code, status, details and request id', () => {
    const { status, body } = run(
      new AppError('VALIDATION_ERROR', 'bad', { details: [{ field: 'a', message: 'm' }] }),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad',
        details: [{ field: 'a', message: 'm' }],
        requestId: 'rid',
      },
    });
    expect(typeof body.error.timestamp).toBe('string');
  });

  it('a deliberate 5xx AppError keeps its message', () => {
    const { status, body } = run(new AppError('COURIER_UNAVAILABLE', 'partner not configured'));
    expect(status).toBe(503);
    expect(body.error.message).toBe('partner not configured');
  });

  it('a CourierError never leaks rawResponse to the client', () => {
    const { body } = run(
      new CourierError('COURIER_REJECTED', {
        courierPartner: 'urbanebolt',
        rawResponse: { message: 'vendor secret text' },
      }),
    );
    expect(JSON.stringify(body)).not.toContain('vendor secret text');
    expect(body.error.code).toBe('COURIER_REJECTED');
  });

  it('a foreign error becomes a generic 500 with no internals', () => {
    const { status, body } = run(new Error('relation "orders" does not exist'));
    expect(status).toBe(500);
    expect(body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(body)).not.toContain('relation');
  });

  it('translates body-parser failures instead of 500ing them', () => {
    const parse = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    expect(run(parse)).toMatchObject({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR' } },
    });

    const big = Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 });
    expect(run(big)).toMatchObject({ status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE' } } });
  });

  it('still produces a well-formed envelope if requestId was never assigned', () => {
    const { body } = run(new AppError('NOT_FOUND', 'x'), { requestId: undefined });
    expect(body.error.requestId).toBe('unassigned');
  });
});
