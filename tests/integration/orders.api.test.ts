import 'reflect-metadata';
import type { Express } from 'express';
import request from 'supertest';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app';
import { AppDataSource } from '../../src/db/data-source';
import { createOrderBody as validOrder } from '../helpers/courier';

/** Full stack against real Postgres; only the courier is fake. */

let app: Express;

beforeAll(async () => {
  ({ app } = await buildApp());
  await AppDataSource.runMigrations();
});

beforeEach(async () => {
  await AppDataSource.query('TRUNCATE TABLE orders CASCADE');
});

afterAll(async () => {
  await AppDataSource.destroy();
});

const row = (id: string) =>
  AppDataSource.query('SELECT * FROM orders WHERE id = $1', [id]).then((r) => r[0]);
const history = (id: string) =>
  AppDataSource.query(
    'SELECT * FROM tracking_history WHERE order_id = $1 ORDER BY status_timestamp',
    [id],
  );

describe('GET /health and /api/v1/couriers', () => {
  it('reports the registered couriers', async () => {
    const health = await request(app).get('/health').expect(200);
    expect(health.body).toMatchObject({
      status: 'ok',
      database: 'up',
      couriers: ['mock', 'urbanebolt'],
    });

    const couriers = await request(app).get('/api/v1/couriers').expect(200);
    expect(couriers.body.data.couriers).toEqual([
      { key: 'mock', displayName: 'Mock Courier' },
      { key: 'urbanebolt', displayName: 'UrbaneBolt' },
    ]);
  });
});

describe('POST /api/v1/orders', () => {
  it('creates a shipment and persists the full audit record', async () => {
    const body = validOrder();
    const res = await request(app).post('/api/v1/orders').send(body).expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      orderId: body.order_id,
      courierPartner: 'mock',
      courierOrderId: expect.stringMatching(/^MOCK-ORD-/),
      awb: expect.stringMatching(/^MOCK\d{10}$/),
      status: 'CREATED',
      labelUrl: expect.stringContaining('/labels/'),
    });
    expect(res.headers['x-request-id']).toBeTruthy();

    const persisted = await row(res.body.data.id);
    expect(persisted).toMatchObject({
      status: 'CREATED',
      courier_partner: 'mock',
      attempt_count: 1,
      last_error: null,
    });
    expect(persisted.normalized_payload.orderId).toBe(body.order_id);
    expect(persisted.request_payload).toMatchObject({ orderNumber: body.order_id });
    expect(persisted.response_payload).toMatchObject({ status: 'Success', awb: res.body.data.awb });
  });

  it('never exposes audit columns in the response', async () => {
    const res = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    for (const key of ['normalizedPayload', 'requestPayload', 'responsePayload', 'lastError']) {
      expect(res.body.data).not.toHaveProperty(key);
    }
  });

  it('400 with field-level errors for invalid input, all at once', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send(
        validOrder({
          cod_amount: undefined,
          pickup: { name: 'x', phone: '1', line1: 'l', city: 'c', state: 's', pincode: '1' },
        }),
      )
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual([
      'cod_amount',
      'pickup.phone',
      'pickup.pincode',
    ]);
  });

  it('400 UNKNOWN_COURIER lists the supported couriers and writes no row', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .send(validOrder({ courier_partner: 'delhivery' }))
      .expect(400);
    expect(res.body.error).toMatchObject({
      code: 'UNKNOWN_COURIER',
      details: [
        {
          field: 'courier_partner',
          message: 'Supported couriers: mock, urbanebolt',
          rejectedValue: 'delhivery',
        },
      ],
    });
    expect(await AppDataSource.query('SELECT count(*)::int AS n FROM orders')).toEqual([{ n: 0 }]);
  });

  it('400 for malformed JSON, with a request id', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Content-Type', 'application/json')
      .send('{"broken')
      .expect(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request body is not valid JSON',
    });
    expect(res.body.error.requestId).toBeTruthy();
  });

  describe('idempotency on order_id', () => {
    it('409 DUPLICATE_ORDER on resubmission, with no second row and no second courier call', async () => {
      const body = validOrder();
      const first = await request(app).post('/api/v1/orders').send(body).expect(201);
      const second = await request(app).post('/api/v1/orders').send(body).expect(409);

      expect(second.body.error).toMatchObject({
        code: 'DUPLICATE_ORDER',
        details: [{ field: 'order_id', rejectedValue: body.order_id }],
        // the 409 is actionable: it says where the existing shipment is
        existing: { id: first.body.data.id, status: 'CREATED', awb: first.body.data.awb },
      });
      const rows = await AppDataSource.query('SELECT awb FROM orders WHERE order_id = $1', [
        body.order_id,
      ]);
      expect(rows).toEqual([{ awb: first.body.data.awb }]);
    });

    it('holds under concurrency: 5 simultaneous submissions → exactly one shipment', async () => {
      const body = validOrder();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => request(app).post('/api/v1/orders').send(body)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      expect(
        await AppDataSource.query('SELECT count(*)::int AS n FROM orders WHERE order_id = $1', [
          body.order_id,
        ]),
      ).toEqual([{ n: 1 }]);
    });
  });

  describe('courier failure is persisted for reconciliation', () => {
    it('rejection → 422, row FAILED with last_error and both audit payloads', async () => {
      const body = validOrder({ metadata: { mock: 'reject' } });
      const res = await request(app).post('/api/v1/orders').send(body).expect(422);
      expect(res.body.error.code).toBe('COURIER_REJECTED');
      expect(JSON.stringify(res.body)).not.toContain('MOCK: rejected by directive');

      const [persisted] = await AppDataSource.query('SELECT * FROM orders WHERE order_id = $1', [
        body.order_id,
      ]);
      expect(persisted).toMatchObject({ status: 'FAILED', awb: null, attempt_count: 1 });
      expect(persisted.last_error).toMatchObject({
        code: 'COURIER_REJECTED',
        courierPartner: 'mock',
      });
      expect(persisted.last_error.rawResponse.message).toBe('MOCK: rejected by directive');
      expect(persisted.request_payload).not.toBeNull();
      expect(persisted.response_payload).not.toBeNull();
    });

    it('courier 5xx → 503 COURIER_UNAVAILABLE after retries, row FAILED', async () => {
      const body = validOrder({ metadata: { mock: 'unavailable' } });
      const res = await request(app).post('/api/v1/orders').send(body).expect(503);
      expect(res.body.error.code).toBe('COURIER_UNAVAILABLE');
      const [r] = await AppDataSource.query(
        'SELECT status, last_error FROM orders WHERE order_id = $1',
        [body.order_id],
      );
      expect(r.status).toBe('FAILED');
      expect(r.last_error.code).toBe('COURIER_UNAVAILABLE');
    });

    it('courier auth failure → 502 COURIER_AUTH_FAILED, row FAILED', async () => {
      const body = validOrder({ metadata: { mock: 'auth-fail' } });
      const res = await request(app).post('/api/v1/orders').send(body).expect(502);
      expect(res.body.error.code).toBe('COURIER_AUTH_FAILED');
      const [r] = await AppDataSource.query('SELECT status FROM orders WHERE order_id = $1', [
        body.order_id,
      ]);
      expect(r.status).toBe('FAILED');
    });

    it('timeout → 504 COURIER_TIMEOUT, row FAILED', async () => {
      const body = validOrder({ metadata: { mock: 'timeout' } });
      const res = await request(app).post('/api/v1/orders').send(body).expect(504);
      expect(res.body.error.code).toBe('COURIER_TIMEOUT');
      const [persisted] = await AppDataSource.query(
        'SELECT status FROM orders WHERE order_id = $1',
        [body.order_id],
      );
      expect(persisted.status).toBe('FAILED');
    });

    it('resubmitting a FAILED order retries it with the new payload — one row, now CREATED', async () => {
      const body = validOrder({ metadata: { mock: 'reject' } });
      await request(app).post('/api/v1/orders').send(body).expect(422);

      const fixed = {
        ...body,
        metadata: {},
        drop: { ...(body.drop as object), name: 'Corrected Name' },
      };
      const res = await request(app).post('/api/v1/orders').send(fixed).expect(201);
      expect(res.body.data.status).toBe('CREATED');

      const rows = await AppDataSource.query(
        'SELECT status, last_error, normalized_payload FROM orders WHERE order_id = $1',
        [body.order_id],
      );
      expect(rows).toHaveLength(1); // same row, not a second one
      expect(rows[0].status).toBe('CREATED');
      expect(rows[0].last_error).toBeNull();
      expect(rows[0].normalized_payload.drop.name).toBe('Corrected Name'); // carries the fix
    });

    it('resubmitting a CREATED order is still a 409 — it has a shipment', async () => {
      const body = validOrder();
      await request(app).post('/api/v1/orders').send(body).expect(201);
      await request(app).post('/api/v1/orders').send(body).expect(409);
    });

    it('concurrent resubmits of a FAILED order dispatch exactly once', async () => {
      const body = validOrder({ metadata: { mock: 'reject' } });
      await request(app).post('/api/v1/orders').send(body).expect(422);

      const retry = { ...body, metadata: { mock: 'slow' } };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => request(app).post('/api/v1/orders').send(retry)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      const [row] = await AppDataSource.query(
        'SELECT attempt_count FROM orders WHERE order_id = $1',
        [body.order_id],
      );
      expect(row.attempt_count).toBe(1);
    });
  });
});

describe('POST /api/v1/orders — UrbaneBolt end to end (UAT answered by nock)', () => {
  const BASE = 'https://courier.test';
  const AUTH = '/api/v1/auth/getToken/';
  const MANIFEST = '/api/v1/services/manifest/';
  const token = (t: string) =>
    nock(BASE).post(AUTH).reply(200, { access_token: t, expires_in: 86400 });

  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/); // supertest talks to the app over loopback
  });
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  it('expired token → 401 → re-auth → replay → 201; courierOrderId and both payloads persisted', async () => {
    token('DEAD');
    nock(BASE, { reqheaders: { authorization: 'Bearer DEAD' } })
      .post(MANIFEST)
      .reply(401, { detail: 'Authentication credentials were not provided.' });
    token('LIVE');
    nock(BASE, { reqheaders: { authorization: 'Bearer LIVE' } })
      .post(MANIFEST)
      .reply(200, {
        status: 'Success',
        successResponse: [
          { status: 'Success', orderNumber: 'X', awbNumber: 200000009999, routeCode: 'GGN/DLHH' },
        ],
        errorResponse: [],
      });

    const body = validOrder({ courier_partner: 'urbanebolt' });
    const res = await request(app).post('/api/v1/orders').send(body).expect(201);
    expect(res.body.data).toMatchObject({
      awb: '200000009999',
      courierOrderId: 'X',
      status: 'CREATED',
    });
    expect(nock.isDone()).toBe(true);

    const [r] = await AppDataSource.query(
      'SELECT courier_order_id, request_payload, response_payload FROM orders WHERE order_id = $1',
      [body.order_id],
    );
    expect(r.courier_order_id).toBe('X');
    expect(r.request_payload.body[0]).toMatchObject({
      customerCode: 'TEST1',
      orderNumber: body.order_id,
    });
    expect(r.response_payload.body.successResponse[0].awbNumber).toBe(200000009999);
  });

  it('401 → re-auth → still 401 → 502 COURIER_AUTH_FAILED, exactly one replay', async () => {
    // The adapter's TokenCache is shared across tests, so how many getToken calls happen
    // depends on prior state; answer all of them and assert on the manifest calls only.
    nock(BASE).persist().post(AUTH).reply(200, { access_token: 'ANY', expires_in: 86400 });
    const manifest = nock(BASE).post(MANIFEST).times(2).reply(401, { detail: 'nope' });

    const res = await request(app)
      .post('/api/v1/orders')
      .send(validOrder({ courier_partner: 'urbanebolt' }))
      .expect(502);
    expect(res.body.error.code).toBe('COURIER_AUTH_FAILED');
    expect(manifest.isDone()).toBe(true); // first call + exactly one replay, no third
  });

  it('HTTP 200 + status:Failed → 422; vendor text kept out of the response, kept in last_error', async () => {
    nock(BASE).persist().post(AUTH).reply(200, { access_token: 'ANY', expires_in: 86400 });
    nock(BASE)
      .post(MANIFEST)
      .reply(200, { status: 'Failed', message: "'shprName' is a required property" });
    const body = validOrder({ courier_partner: 'urbanebolt' });
    const res = await request(app).post('/api/v1/orders').send(body).expect(422);
    expect(JSON.stringify(res.body)).not.toContain('shprName');
    const [r] = await AppDataSource.query('SELECT last_error FROM orders WHERE order_id = $1', [
      body.order_id,
    ]);
    expect(r.last_error.rawResponse.message).toContain('shprName');
  });
});

describe('GET /api/v1/orders/:orderId', () => {
  it('returns the order', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).expect(200);
    expect(res.body.data).toEqual(created.body.data);
  });
  it('404 for a well-formed id that does not exist', async () => {
    const res = await request(app)
      .get('/api/v1/orders/00000000-0000-4000-8000-000000000000')
      .expect(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });
  it('400 for a malformed id — never reaches the database', async () => {
    const res = await request(app).get('/api/v1/orders/not-a-uuid').expect(400);
    expect(res.body.error.details).toEqual([{ field: 'orderId', message: 'must be a UUID' }]);
  });
});

describe('GET /api/v1/orders/:orderId/track', () => {
  it('appends new events, dedupes repeats, and updates the order status', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    const id = created.body.data.id;

    const t1 = await request(app).get(`/api/v1/orders/${id}/track`).expect(200);
    expect(t1.body.data.status).toBe('PICKED_UP');
    expect(t1.body.data.events.map((e: { status: string }) => e.status)).toEqual([
      'CREATED',
      'PICKED_UP',
    ]);

    const t2 = await request(app).get(`/api/v1/orders/${id}/track`).expect(200);
    expect(t2.body.data.status).toBe('IN_TRANSIT');
    expect(t2.body.data.events).toHaveLength(3);

    // 2 + 3 reported, 3 distinct.
    expect(await history(id)).toHaveLength(3);
    expect((await row(id)).status).toBe('IN_TRANSIT');
  });

  it('tracking_history rows carry both the courier time and our ingest time', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    await request(app).get(`/api/v1/orders/${created.body.data.id}/track`).expect(200);
    const [event] = await history(created.body.data.id);
    expect(event.status_timestamp).toBeInstanceOf(Date);
    expect(event.created_at).toBeInstanceOf(Date);
    expect(event.courier_status_code).toBe('MOCK_CREATED');
    expect(event.raw_payload).toMatchObject({ step: 0 });
  });

  it('the same code in the same minute at two hubs is two events, not one', async () => {
    const created = await request(app)
      .post('/api/v1/orders')
      .send(validOrder({ metadata: { mock: 'two-hubs' } }))
      .expect(201);
    const id = created.body.data.id;
    await request(app).get(`/api/v1/orders/${id}/track`).expect(200); // PICKED_UP
    await request(app).get(`/api/v1/orders/${id}/track`).expect(200); // IN_TRANSIT ×2 hubs
    await request(app).get(`/api/v1/orders/${id}/track`).expect(200); // re-poll: nothing new

    const rows = await history(id);
    const inTransit = rows.filter((r: { status: string }) => r.status === 'IN_TRANSIT');
    expect(inTransit).toHaveLength(2);
    expect(inTransit.map((r: { location: string }) => r.location).sort()).toEqual([
      'Mock Hub',
      'Mock Hub 2',
    ]);
    expect(inTransit[0].status_timestamp).toEqual(inTransit[1].status_timestamp); // same minute
  });

  it('an unknown courier status is recorded with status null and leaves the order status alone', async () => {
    const created = await request(app)
      .post('/api/v1/orders')
      .send(validOrder({ metadata: { mock: 'unknown-status' } }))
      .expect(201);
    const id = created.body.data.id;

    const res = await request(app).get(`/api/v1/orders/${id}/track`).expect(200);
    expect(res.body.data.events.at(-1)).toMatchObject({
      status: null,
      courierStatusCode: 'MOCK_ZZZ',
      courierStatusText: 'something new',
    });
    expect(res.body.data.status).toBe('CREATED'); // not overwritten with a guess
    expect((await history(id)).at(-1)).toMatchObject({
      status: null,
      courier_status_code: 'MOCK_ZZZ',
    });
    expect((await row(id)).status).toBe('CREATED');
  });

  it('courier failure during tracking → normalized error, order and history untouched', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    await AppDataSource.query("UPDATE orders SET awb='MOCK9999999999' WHERE id=$1", [
      created.body.data.id,
    ]);
    const res = await request(app).get(`/api/v1/orders/${created.body.data.id}/track`).expect(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect((await row(created.body.data.id)).status).toBe('CREATED');
    expect(await history(created.body.data.id)).toHaveLength(0);
  });

  it('409 INVALID_ORDER_STATE for a FAILED order that has no AWB', async () => {
    const body = validOrder({ metadata: { mock: 'reject' } });
    await request(app).post('/api/v1/orders').send(body).expect(422);
    const [failed] = await AppDataSource.query('SELECT id FROM orders WHERE order_id = $1', [
      body.order_id,
    ]);
    const res = await request(app).get(`/api/v1/orders/${failed.id}/track`).expect(409);
    expect(res.body.error.code).toBe('INVALID_ORDER_STATE');
  });

  it('503 COURIER_UNAVAILABLE when the stored partner is no longer configured', async () => {
    const [{ id }] = await AppDataSource.query(
      `INSERT INTO orders (order_id, courier_partner, status, awb, normalized_payload)
       VALUES ('LEGACY-1', 'delhivery', 'CREATED', 'DLV1', '{"orderId":"LEGACY-1"}') RETURNING id`,
    );
    const res = await request(app).get(`/api/v1/orders/${id}/track`).expect(503);
    expect(res.body.error).toMatchObject({
      code: 'COURIER_UNAVAILABLE',
      message: expect.stringContaining('delhivery'),
    });
  });
});

describe('POST /api/v1/orders/:orderId/cancel', () => {
  it('cancels a fresh shipment and persists CANCELLED', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    const res = await request(app)
      .post(`/api/v1/orders/${created.body.data.id}/cancel`)
      .expect(200);
    expect(res.body.data).toEqual({ cancelled: true, message: 'Cancelled' });
    expect((await row(created.body.data.id)).status).toBe('CANCELLED');
  });

  it('is idempotent: cancelling twice does not call the courier again', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    await request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).expect(200);
    const again = await request(app)
      .post(`/api/v1/orders/${created.body.data.id}/cancel`)
      .expect(200);
    expect(again.body.data.message).toBe('Order is already cancelled');
  });

  it('422 when the courier refuses (already picked up), status unchanged', async () => {
    const created = await request(app).post('/api/v1/orders').send(validOrder()).expect(201);
    await request(app).get(`/api/v1/orders/${created.body.data.id}/track`).expect(200); // → PICKED_UP
    const res = await request(app)
      .post(`/api/v1/orders/${created.body.data.id}/cancel`)
      .expect(422);
    expect(res.body.error.code).toBe('COURIER_REJECTED');
    expect((await row(created.body.data.id)).status).toBe('PICKED_UP');
  });

  it('409 for a DELIVERED order without calling the courier', async () => {
    const [{ id }] = await AppDataSource.query(
      `INSERT INTO orders (order_id, courier_partner, status, awb, normalized_payload)
       VALUES ('DONE-1', 'mock', 'DELIVERED', 'MOCK0000000099', '{"orderId":"DONE-1"}') RETURNING id`,
    );
    const res = await request(app).post(`/api/v1/orders/${id}/cancel`).expect(409);
    expect(res.body.error.code).toBe('INVALID_ORDER_STATE');
  });
});

describe('unknown routes', () => {
  it('return the same envelope', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });
});
