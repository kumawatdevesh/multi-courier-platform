import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { CourierHttpClient } from '../../src/couriers/shared/http-client';
import { TokenCache } from '../../src/couriers/shared/token-cache';
import { CourierError } from '../../src/errors/courier-error';
import { BASE, courierConfig, testContext, useNock } from '../helpers/courier';

function client(overrides = {}, tokens?: TokenCache) {
  return new CourierHttpClient(courierConfig(overrides), tokens);
}

describe('CourierHttpClient', () => {
  useNock();

  describe('authentication', () => {
    it('attaches the cached bearer token', async () => {
      const tokens = new TokenCache(async () => ({ token: 'TOK', expiresInSec: 3600 }));
      const scope = nock(BASE, { reqheaders: { authorization: 'Bearer TOK' } })
        .get('/ping')
        .reply(200, { ok: true });

      const { ctx } = testContext();
      const res = await client({}, tokens).request<{ ok: boolean }>(
        { method: 'GET', path: '/ping' },
        ctx,
      );
      expect(res.data.ok).toBe(true);
      expect(scope.isDone()).toBe(true);
    });

    it('on 401: invalidates, re-authenticates, and replays exactly once', async () => {
      const issue = vi
        .fn()
        .mockResolvedValueOnce({ token: 'DEAD', expiresInSec: 3600 })
        .mockResolvedValueOnce({ token: 'LIVE', expiresInSec: 3600 });
      const tokens = new TokenCache(issue);

      nock(BASE, { reqheaders: { authorization: 'Bearer DEAD' } })
        .get('/ping')
        .reply(401, { detail: 'nope' });
      nock(BASE, { reqheaders: { authorization: 'Bearer LIVE' } })
        .get('/ping')
        .reply(200, { ok: true });

      const { ctx } = testContext();
      const res = await client({}, tokens).request<{ ok: boolean }>(
        { method: 'GET', path: '/ping' },
        ctx,
      );
      expect(res.data.ok).toBe(true);
      expect(issue).toHaveBeenCalledTimes(2);
    });

    it('a second 401 after re-auth is COURIER_AUTH_FAILED, not another replay', async () => {
      const tokens = new TokenCache(async () => ({ token: 'T', expiresInSec: 3600 }));
      nock(BASE).get('/ping').times(2).reply(401, { detail: 'nope' });

      const { ctx } = testContext();
      await expect(
        client({}, tokens).request({ method: 'GET', path: '/ping' }, ctx),
      ).rejects.toMatchObject({
        code: 'COURIER_AUTH_FAILED',
        retryable: false,
      });
      expect(nock.isDone()).toBe(true);
    });

    it('a client built without a TokenCache sends no Authorization header and never replays', async () => {
      nock(BASE, { badheaders: ['authorization'] })
        .post('/auth')
        .reply(401, { detail: 'nope' });

      const { ctx } = testContext();
      await expect(client().request({ method: 'POST', path: '/auth' }, ctx)).rejects.toMatchObject({
        code: 'COURIER_AUTH_FAILED',
      });
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('transient failures', () => {
    it('retries 5xx with backoff and succeeds', async () => {
      nock(BASE).get('/x').reply(503).get('/x').reply(502).get('/x').reply(200, { ok: 1 });
      const { ctx } = testContext();
      const res = await client().request<{ ok: number }>({ method: 'GET', path: '/x' }, ctx);
      expect(res.data.ok).toBe(1);
      expect(nock.isDone()).toBe(true);
    });

    it('exhausts retries and surfaces COURIER_UNAVAILABLE', async () => {
      nock(BASE).get('/x').times(3).reply(503, { err: 'down' });
      const { ctx } = testContext();
      await expect(client().request({ method: 'GET', path: '/x' }, ctx)).rejects.toMatchObject({
        code: 'COURIER_UNAVAILABLE',
        retryable: true,
        courierPartner: 'urbanebolt',
      });
      expect(nock.isDone()).toBe(true);
    });

    it('maps a timeout to COURIER_TIMEOUT and retries it', async () => {
      nock(BASE).get('/slow').times(3).delayConnection(200).reply(200, {});
      const { ctx } = testContext();
      const err = await client({ timeoutMs: 50 })
        .request({ method: 'GET', path: '/slow' }, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CourierError);
      expect((err as CourierError).code).toBe('COURIER_TIMEOUT');
      expect(nock.isDone()).toBe(true);
    });

    it('maps 429 to RATE_LIMITED', async () => {
      nock(BASE).get('/x').times(3).reply(429);
      const { ctx } = testContext();
      await expect(client().request({ method: 'GET', path: '/x' }, ctx)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });
  });

  describe('client errors', () => {
    it('does not retry a 4xx and maps it to COURIER_REJECTED with the raw body kept', async () => {
      nock(BASE).post('/x').reply(400, { vendor: 'says no' });
      const { ctx } = testContext();
      await expect(
        client().request({ method: 'POST', path: '/x', body: {} }, ctx),
      ).rejects.toMatchObject({
        code: 'COURIER_REJECTED',
        retryable: false,
        rawResponse: { vendor: 'says no' },
      });
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('audit capture', () => {
    it('records the exact request and response, including failures', async () => {
      nock(BASE).post('/x').reply(422, { reason: 'bad' });
      const { ctx, audits } = testContext();
      await client()
        .request({ method: 'POST', path: '/x', body: { a: 1 } }, ctx)
        .catch(() => undefined);

      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        request: { method: 'POST', path: '/x', body: { a: 1 } },
        response: { status: 422, body: { reason: 'bad' } },
      });
      expect(audits[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('records one entry per attempt when retrying', async () => {
      nock(BASE).get('/x').reply(503).get('/x').reply(200, {});
      const { ctx, audits } = testContext();
      await client().request({ method: 'GET', path: '/x' }, ctx);
      expect(audits.map((a) => (a.response as { status: number }).status)).toEqual([503, 200]);
    });

    it('propagates the request id as a header', async () => {
      nock(BASE, { reqheaders: { 'x-request-id': 'req-test' } })
        .get('/x')
        .reply(200, {});
      const { ctx } = testContext();
      await client().request({ method: 'GET', path: '/x' }, ctx);
      expect(nock.isDone()).toBe(true);
    });
  });
});
