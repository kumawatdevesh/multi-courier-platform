import axios, { AxiosError, type AxiosInstance, type Method } from 'axios';

import { CourierError } from '../../errors/courier-error';
import { logger } from '../../lib/logger';
import type { CourierConfig, CourierContext } from '../courier.interface';
import { withRetry } from './retry';
import type { TokenCache } from './token-cache';

export interface CourierRequest {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface CourierResponse<T> {
  status: number;
  data: T;
}

/**
 * Owns timeouts, retry/backoff, bearer tokens with re-auth-once on 401, and audit capture,
 * so no adapter reimplements them. Without a TokenCache the client is unauthenticated.
 */
export class CourierHttpClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly config: CourierConfig,
    private readonly tokens?: TokenCache,
  ) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async request<T>(req: CourierRequest, ctx: CourierContext): Promise<CourierResponse<T>> {
    return withRetry(() => this.sendWithAuthReplay<T>(req, ctx), {
      attempts: this.config.retryAttempts,
      baseDelayMs: this.config.retryBaseDelayMs,
      isRetryable: (error) => error instanceof CourierError && error.retryable,
      context: {
        courierPartner: this.config.key,
        requestId: ctx.requestId,
        orderId: ctx.orderId,
        path: req.path,
      },
    });
  }

  /** Replays once on 401 — outside the retry loop; an expired token is not a transient fault. */
  private async sendWithAuthReplay<T>(
    req: CourierRequest,
    ctx: CourierContext,
  ): Promise<CourierResponse<T>> {
    const first = await this.send<T>(req, ctx);
    if (first.status !== 401 || !this.tokens) {
      return this.assertTransportOk(first, req);
    }

    logger.warn(
      { courierPartner: this.config.key, requestId: ctx.requestId, path: req.path },
      'courier rejected token, re-authenticating and replaying once',
    );
    this.tokens.invalidate();

    const replay = await this.send<T>(req, ctx);
    if (replay.status === 401) {
      throw new CourierError('COURIER_AUTH_FAILED', {
        courierPartner: this.config.key,
        rawResponse: replay.data,
      });
    }
    return this.assertTransportOk(replay, req);
  }

  private async send<T>(req: CourierRequest, ctx: CourierContext): Promise<CourierResponse<T>> {
    const headers: Record<string, string> = { 'X-Request-Id': ctx.requestId };
    if (this.tokens) {
      headers.Authorization = `Bearer ${await this.tokens.get()}`;
    }

    const auditRequest = { method: req.method, path: req.path, query: req.query, body: req.body };
    const startedAt = Date.now();
    try {
      const response = await this.http.request<T>({
        method: req.method,
        url: req.path,
        params: req.query,
        data: req.body,
        headers,
      });
      ctx.audit({
        request: auditRequest,
        response: { status: response.status, body: response.data },
        durationMs: Date.now() - startedAt,
      });
      return { status: response.status, data: response.data };
    } catch (error) {
      ctx.audit({
        request: auditRequest,
        response: { error: error instanceof Error ? error.message : String(error) },
        durationMs: Date.now() - startedAt,
      });
      throw this.toTransportError(error, req);
    }
  }

  private toTransportError(error: unknown, req: CourierRequest): CourierError {
    const axiosError = error as AxiosError;
    const timedOut = axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT';

    return new CourierError(timedOut ? 'COURIER_TIMEOUT' : 'COURIER_UNAVAILABLE', {
      courierPartner: this.config.key,
      courierCode: axiosError.code,
      context: { path: req.path, timeoutMs: this.config.timeoutMs },
      cause: error,
    });
  }

  /** HTTP-status errors only; a 200 carrying a failure envelope is the adapter's job. */
  private assertTransportOk<T>(
    response: CourierResponse<T>,
    req: CourierRequest,
  ): CourierResponse<T> {
    const { status } = response;
    if (status < 400) return response;

    const opts = {
      courierPartner: this.config.key,
      rawResponse: response.data,
      courierCode: String(status),
      context: { path: req.path },
    };

    if (status === 401 || status === 403) throw new CourierError('COURIER_AUTH_FAILED', opts);
    if (status === 429) throw new CourierError('RATE_LIMITED', opts);
    if (status >= 500) throw new CourierError('COURIER_UNAVAILABLE', opts);
    throw new CourierError('COURIER_REJECTED', opts);
  }
}
