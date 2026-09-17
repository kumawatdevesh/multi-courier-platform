import nock from 'nock';
import { describe, expect, it } from 'vitest';

import { AUTH_PATH } from '../../src/couriers/urbanebolt/urbanebolt.auth';
import { PATHS, UrbaneBoltClient } from '../../src/couriers/urbanebolt/urbanebolt.client';
import { BASE, courierConfig, stubAuth, testContext, useNock } from '../helpers/courier';

describe('UrbaneBoltClient — envelope handling', () => {
  useNock();

  describe('manifest', () => {
    it('returns the created shipment from successResponse', async () => {
      stubAuth();
      nock(BASE)
        .post(PATHS.manifest)
        .reply(200, {
          status: 'Success',
          successResponse: [
            {
              status: 'Success',
              orderNumber: 'ORD-1',
              awbNumber: 200000007895,
              routeCode: 'GGN/DLHH',
            },
          ],
          errorResponse: [],
        });
      const { ctx } = testContext();
      const created = await new UrbaneBoltClient(courierConfig()).manifest(
        { orderNumber: 'ORD-1' },
        ctx,
      );
      expect(created.awbNumber).toBe(200000007895);
    });

    it('HTTP 200 + status:"Failed" is a rejection, not a success', async () => {
      stubAuth();
      nock(BASE)
        .post(PATHS.manifest)
        .reply(200, { status: 'Failed', message: "'shprName' is a required property" });
      const { ctx } = testContext();
      await expect(new UrbaneBoltClient(courierConfig()).manifest({}, ctx)).rejects.toMatchObject({
        code: 'COURIER_REJECTED',
        retryable: false,
        rawResponse: { status: 'Failed' },
      });
    });

    it('HTTP 200 + status:"Success" with the order in errorResponse[] is a rejection', async () => {
      stubAuth();
      nock(BASE)
        .post(PATHS.manifest)
        .reply(200, {
          status: 'Success',
          successResponse: [],
          errorResponse: [
            { orderNumber: 'ORD-1', status: 'Failed', message: 'orderNumber already shipped!' },
          ],
        });
      const { ctx } = testContext();
      const err = await new UrbaneBoltClient(courierConfig())
        .manifest({ orderNumber: 'ORD-1' }, ctx)
        .catch((e) => e);

      expect(err.code).toBe('DUPLICATE_ORDER');
      expect(err.message).not.toContain('already shipped');
      expect(err.rawResponse.errorResponse[0].message).toBe('orderNumber already shipped!');
    });
  });

  describe('track', () => {
    it('returns tracking data', async () => {
      stubAuth();
      nock(BASE)
        .get(PATHS.tracking)
        .query({ awb: '1' })
        .reply(200, {
          status: 'Success',
          message: 'Tracking',
          data: { awbNumber: 1, currentStatusCode: 'MAN', scans: [] },
        });
      const { ctx } = testContext();
      const data = await new UrbaneBoltClient(courierConfig()).track('1', ctx);
      expect(data.currentStatusCode).toBe('MAN');
    });

    it('HTTP 200 + "Data Not Found" is COURIER_REJECTED, not a success with empty data', async () => {
      stubAuth();
      nock(BASE)
        .get(PATHS.tracking)
        .query({ awb: '999' })
        .reply(200, { status: 'Failed', message: 'Data Not Found', data: [] });
      const { ctx } = testContext();
      await expect(new UrbaneBoltClient(courierConfig()).track('999', ctx)).rejects.toMatchObject({
        code: 'COURIER_REJECTED',
      });
    });

    it('status:"Success" but data:[] (unknown AWB) is ORDER_NOT_FOUND', async () => {
      stubAuth();
      nock(BASE)
        .get(PATHS.tracking)
        .query({ awb: '999' })
        .reply(200, { status: 'Success', data: [] });
      const { ctx } = testContext();
      await expect(new UrbaneBoltClient(courierConfig()).track('999', ctx)).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    });
  });

  describe('cancel', () => {
    it('succeeds on successResponse', async () => {
      stubAuth();
      nock(BASE)
        .post(PATHS.cancel, { awbs: '1' })
        .reply(200, {
          status: 'Success',
          successResponse: [{ awb: '1', message: 'Cancelled' }],
          failureResponse: [],
        });
      const { ctx } = testContext();
      await expect(new UrbaneBoltClient(courierConfig()).cancel('1', ctx)).resolves.toEqual({
        message: 'Cancelled',
      });
    });

    it('a failureResponse entry is a rejection with our wording', async () => {
      stubAuth();
      nock(BASE)
        .post(PATHS.cancel)
        .reply(200, {
          status: 'Success',
          successResponse: [],
          failureResponse: [{ awb: '1', message: 'Already picked up by rider' }],
        });
      const { ctx } = testContext();
      const err = await new UrbaneBoltClient(courierConfig()).cancel('1', ctx).catch((e) => e);
      expect(err.code).toBe('COURIER_REJECTED');
      expect(err.message).not.toContain('rider');
    });
  });

  it('a courier outage during auth costs one auth call per outer attempt, not three', async () => {
    const auth = nock(BASE).post(AUTH_PATH).times(3).reply(503, 'down');
    const { ctx } = testContext();
    await expect(new UrbaneBoltClient(courierConfig()).track('1', ctx)).rejects.toMatchObject({
      code: 'COURIER_UNAVAILABLE',
    });
    // outer loop: 3 attempts; each triggers exactly one getToken — 3 total, never 9
    expect(auth.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('a real 401 triggers re-auth and a replay', async () => {
    stubAuth('DEAD');
    nock(BASE, { reqheaders: { authorization: 'Bearer DEAD' } })
      .get(PATHS.tracking)
      .query(true)
      .reply(401, { detail: 'Authentication credentials were not provided.' });
    stubAuth('LIVE');
    nock(BASE, { reqheaders: { authorization: 'Bearer LIVE' } })
      .get(PATHS.tracking)
      .query(true)
      .reply(200, { status: 'Success', data: { awbNumber: 1, scans: [] } });

    const { ctx } = testContext();
    const data = await new UrbaneBoltClient(courierConfig()).track('1', ctx);
    expect(data.awbNumber).toBe(1);
    expect(nock.isDone()).toBe(true);
  });
});
