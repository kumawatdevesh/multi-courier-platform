import 'reflect-metadata';
import type { Express } from 'express';
import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app';
import { findCourier } from '../../src/couriers/courier.registry';
import { AppDataSource } from '../../src/db/data-source';
import type { DispatchWorker } from '../../src/jobs/dispatch.worker';
import { createOrderBody } from '../helpers/courier';

/** The worker is driven by hand (runOnce) so each test controls exactly when dispatch happens. */

let app: Express;
let worker: DispatchWorker;

beforeAll(async () => {
  ({ app, worker } = await buildApp());
  await AppDataSource.runMigrations();
});
beforeEach(async () => {
  await AppDataSource.query('TRUNCATE TABLE orders, batches CASCADE');
});
afterAll(async () => {
  await AppDataSource.destroy();
});

const submit = (orders: unknown[]) => request(app).post('/api/v1/orders/bulk').send({ orders });
const getBatch = (id: string) => request(app).get(`/api/v1/batches/${id}`);
const drain = async () => {
  while ((await worker.runOnce()) > 0) {
    /* keep claiming until nothing is PENDING */
  }
};
const statusCounts = (batchId: string) =>
  AppDataSource.query(
    'SELECT status, count(*)::int AS n FROM orders WHERE batch_id=$1 GROUP BY status ORDER BY status',
    [batchId],
  );

describe('POST /api/v1/orders/bulk', () => {
  it('202 with batch_id immediately; nothing dispatched until the worker runs', async () => {
    const res = await submit([createOrderBody(), createOrderBody(), createOrderBody()]).expect(202);
    expect(res.body.data).toMatchObject({ total: 3, accepted: 3, duplicates: [] });
    expect(res.body.data.batchId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await statusCounts(res.body.data.batchId)).toEqual([{ status: 'PENDING', n: 3 }]);
    const before = await getBatch(res.body.data.batchId).expect(200);
    expect(before.body.data).toMatchObject({
      status: 'QUEUED',
      pending: 3,
      succeeded: 0,
      failed: 0,
    });
  });

  it('rejects the whole request on a validation error, writing nothing', async () => {
    const bad = createOrderBody();
    (bad.drop as Record<string, unknown>).pincode = '12';
    const res = await submit([createOrderBody(), bad]).expect(400);
    expect(res.body.error.details).toEqual([
      { field: 'orders.1.drop.pincode', message: 'must be a 6-digit pincode' },
    ]);
    expect(await AppDataSource.query('SELECT count(*)::int AS n FROM batches')).toEqual([{ n: 0 }]);
  });

  it('rejects the whole request on an unknown courier, naming the index', async () => {
    const res = await submit([
      createOrderBody(),
      createOrderBody({ courier_partner: 'delhivery' }),
    ]).expect(400);
    expect(res.body.error.code).toBe('UNKNOWN_COURIER');
    expect(res.body.error.details[0]).toMatchObject({
      field: 'orders.1.courier_partner',
      rejectedValue: 'delhivery',
    });
    expect(await AppDataSource.query('SELECT count(*)::int AS n FROM orders')).toEqual([{ n: 0 }]);
  });

  it('caps at 100 orders', async () => {
    const res = await submit(Array.from({ length: 101 }, () => createOrderBody())).expect(400);
    expect(res.body.error.details[0].field).toBe('orders');
  });

  describe('idempotency on order_id', () => {
    it('a duplicate inside one payload is inserted once and reported', async () => {
      const dup = createOrderBody({ order_id: 'BULK-DUP' });
      const res = await submit([dup, createOrderBody(), dup]).expect(202);
      expect(res.body.data).toMatchObject({
        total: 3,
        accepted: 2,
        duplicates: [{ orderId: 'BULK-DUP', reason: 'DUPLICATE_ORDER' }],
      });
      expect(
        await AppDataSource.query(
          "SELECT count(*)::int AS n FROM orders WHERE order_id='BULK-DUP'",
        ),
      ).toEqual([{ n: 1 }]);
    });

    it('resubmitting a whole batch creates zero new shipments', async () => {
      const orders = [createOrderBody(), createOrderBody(), createOrderBody()];
      const first = await submit(orders).expect(202);
      await drain();
      const awbsBefore = await AppDataSource.query('SELECT awb FROM orders ORDER BY awb');

      const second = await submit(orders).expect(202);
      expect(second.body.data).toMatchObject({ total: 3, accepted: 0 });
      expect(second.body.data.duplicates).toHaveLength(3);
      await drain();

      expect(await AppDataSource.query('SELECT awb FROM orders ORDER BY awb')).toEqual(awbsBefore);
      expect(first.body.data.batchId).not.toBe(second.body.data.batchId);
    });

    it('a FAILED order in a resubmitted batch is retried under the new batch', async () => {
      const bad = createOrderBody({ order_id: 'RETRY-1', metadata: { mock: 'reject' } });
      const first = await submit([bad]).expect(202);
      await drain();
      expect((await getBatch(first.body.data.batchId)).body.data).toMatchObject({ failed: 1 });

      const second = await submit([{ ...bad, metadata: {} }]).expect(202);
      expect(second.body.data).toMatchObject({ accepted: 1, duplicates: [] });
      await drain();

      const rows = await AppDataSource.query(
        "SELECT status, batch_id FROM orders WHERE order_id='RETRY-1'",
      );
      expect(rows).toEqual([{ status: 'CREATED', batch_id: second.body.data.batchId }]);
      expect((await getBatch(second.body.data.batchId)).body.data).toMatchObject({
        status: 'COMPLETED',
        succeeded: 1,
      });
    });

    it('an order_id already used by a single create is a duplicate for bulk too', async () => {
      const single = createOrderBody({ order_id: 'SINGLE-1' });
      await request(app).post('/api/v1/orders').send(single).expect(201);
      const res = await submit([single]).expect(202);
      expect(res.body.data).toMatchObject({ accepted: 0, duplicates: [{ orderId: 'SINGLE-1' }] });
    });
  });
});

describe('worker', () => {
  it('drains a batch: per-order outcomes, partial success, batch COMPLETED', async () => {
    const res = await submit([
      createOrderBody({ order_id: 'W-ok-1' }),
      createOrderBody({ order_id: 'W-ok-2' }),
      createOrderBody({ order_id: 'W-rej', metadata: { mock: 'reject' } }),
      createOrderBody({ order_id: 'W-timeout', metadata: { mock: 'timeout' } }),
    ]).expect(202);
    const batchId = res.body.data.batchId;

    await drain();

    const view = (await getBatch(batchId).expect(200)).body.data;
    expect(view).toMatchObject({
      status: 'COMPLETED',
      total: 4,
      accepted: 4,
      succeeded: 2,
      failed: 2,
      pending: 0,
    });
    expect(view.completedAt).toBeTruthy();

    const byId = Object.fromEntries(view.orders.map((o: { orderId: string }) => [o.orderId, o]));
    expect(byId['W-ok-1']).toMatchObject({
      status: 'CREATED',
      awb: expect.stringMatching(/^MOCK/),
      error: null,
    });
    expect(byId['W-rej']).toMatchObject({
      status: 'FAILED',
      awb: null,
      error: { code: 'COURIER_REJECTED' },
    });
    expect(byId['W-timeout']).toMatchObject({
      status: 'FAILED',
      error: { code: 'COURIER_TIMEOUT' },
    });
    // the vendor's wording is not in the batch view either
    expect(JSON.stringify(view)).not.toContain('MOCK: rejected');
  });

  it('100 orders: 202, then every one dispatched', async () => {
    const res = await submit(Array.from({ length: 100 }, () => createOrderBody())).expect(202);
    expect(res.body.data).toMatchObject({ total: 100, accepted: 100 });
    await drain();
    expect(await statusCounts(res.body.data.batchId)).toEqual([{ status: 'CREATED', n: 100 }]);
    expect((await getBatch(res.body.data.batchId)).body.data).toMatchObject({
      status: 'COMPLETED',
      succeeded: 100,
      failed: 0,
    });
  });

  it('mixed couriers in one batch: each order goes to its own partner', async () => {
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
    try {
      nock('https://courier.test')
        .post('/api/v1/auth/getToken/')
        .reply(200, { access_token: 'T', expires_in: 86400 });
      nock('https://courier.test')
        .post('/api/v1/services/manifest/')
        .times(2)
        .reply(200, (_uri, body) => ({
          status: 'Success',
          successResponse: [
            {
              status: 'Success',
              orderNumber: (body as Array<{ orderNumber: string }>)[0]!.orderNumber,
              awbNumber: 200000001000 + Math.floor(Math.random() * 1000),
            },
          ],
          errorResponse: [],
        }));

      const res = await submit([
        createOrderBody({ order_id: 'MIX-m1' }),
        createOrderBody({ order_id: 'MIX-u1', courier_partner: 'urbanebolt' }),
        createOrderBody({ order_id: 'MIX-m2' }),
        createOrderBody({ order_id: 'MIX-u2', courier_partner: 'urbanebolt' }),
      ]).expect(202);
      await drain();

      const rows: Array<{
        order_id: string;
        courier_partner: string;
        status: string;
        awb: string;
      }> = await AppDataSource.query(
        'SELECT order_id, courier_partner, status, awb FROM orders WHERE batch_id=$1 ORDER BY order_id',
        [res.body.data.batchId],
      );
      expect(rows.map((r) => [r.order_id, r.courier_partner, r.status])).toEqual([
        ['MIX-m1', 'mock', 'CREATED'],
        ['MIX-m2', 'mock', 'CREATED'],
        ['MIX-u1', 'urbanebolt', 'CREATED'],
        ['MIX-u2', 'urbanebolt', 'CREATED'],
      ]);
      expect(rows.filter((r) => r.awb.startsWith('MOCK'))).toHaveLength(2);
      expect(rows.filter((r) => /^2000000/.test(r.awb))).toHaveLength(2);
      expect(nock.isDone()).toBe(true);
    } finally {
      nock.cleanAll();
      nock.enableNetConnect();
    }
  });

  it('claims in chunks of batchSize and reports how many it took', async () => {
    await submit(Array.from({ length: 25 }, () => createOrderBody())).expect(202);
    expect(await worker.runOnce()).toBe(20);
    expect(await worker.runOnce()).toBe(5);
    expect(await worker.runOnce()).toBe(0);
  });

  it('two concurrent ticks never claim the same row (FOR UPDATE SKIP LOCKED)', async () => {
    const res = await submit(Array.from({ length: 30 }, () => createOrderBody())).expect(202);
    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(a + b).toBe(30);
    const counts = await statusCounts(res.body.data.batchId);
    expect(counts).toEqual([{ status: 'CREATED', n: 30 }]);
  });

  it('never claims a single-create order that is being dispatched inline (race)', async () => {
    // The HTTP request inserts and dispatches in one go; the mock makes the dispatch slow.
    // supertest is lazy — .then() is what actually sends the request.
    const inFlight = request(app)
      .post('/api/v1/orders')
      .send(createOrderBody({ order_id: 'RACE-1', metadata: { mock: 'slow' } }))
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 100)); // request is mid-dispatch now

    expect(await worker.runOnce()).toBe(0); // nothing PENDING: the row is PROCESSING

    const res = await inFlight;
    expect(res.status).toBe(201);
    const [row] = await AppDataSource.query(
      "SELECT status, attempt_count FROM orders WHERE order_id='RACE-1'",
    );
    expect(row).toEqual({ status: 'CREATED', attempt_count: 1 }); // dispatched exactly once
    expect(res.body.data.awb).toMatch(/^MOCK/);
  });

  it('a PROCESSING row with a live lease is never re-claimed', async () => {
    const res = await submit([createOrderBody({ order_id: 'OWNED' })]).expect(202);
    await AppDataSource.query(
      "UPDATE orders SET status='PROCESSING', lease_until = now() + interval '1 hour' WHERE order_id='OWNED'",
    );
    expect(await worker.runOnce()).toBe(0);
    expect(await statusCounts(res.body.data.batchId)).toEqual([{ status: 'PROCESSING', n: 1 }]);
  });

  it('the heartbeat keeps a slow dispatch owned past the lease length', async () => {
    // lease is 300 ms in tests; the slow mock takes 400 ms. Without the heartbeat the
    // second tick would re-claim and dispatch it a second time.
    await submit([createOrderBody({ order_id: 'SLOW-1', metadata: { mock: 'slow' } })]).expect(202);
    const first = worker.runOnce(); // claims + dispatches (400 ms)
    await new Promise((r) => setTimeout(r, 350)); // lease would have lapsed by now
    expect(await worker.runOnce()).toBe(0); // …but the heartbeat extended it
    expect(await first).toBe(1);
    const [row] = await AppDataSource.query(
      "SELECT status, attempt_count, lease_until FROM orders WHERE order_id='SLOW-1'",
    );
    expect(row).toMatchObject({ status: 'CREATED', attempt_count: 1, lease_until: null });
  });

  it('a lapsed lease on an idempotent partner is re-dispatched automatically', async () => {
    const res = await submit([createOrderBody({ order_id: 'DEAD-1' })]).expect(202);
    // worker died mid-call: PROCESSING, lease in the past, no heartbeat coming
    await AppDataSource.query(
      "UPDATE orders SET status='PROCESSING', lease_until = now() - interval '1 second' WHERE order_id='DEAD-1'",
    );
    expect(await worker.runOnce()).toBe(1);
    expect(await statusCounts(res.body.data.batchId)).toEqual([{ status: 'CREATED', n: 1 }]);
    expect((await getBatch(res.body.data.batchId)).body.data).toMatchObject({
      status: 'COMPLETED',
      succeeded: 1,
    });
  });

  it('a lapsed lease on a NON-idempotent partner is marked FAILED, never re-dispatched', async () => {
    const mock = findCourier('mock') as { idempotentOnReference: boolean };
    mock.idempotentOnReference = false;
    try {
      const res = await submit([createOrderBody({ order_id: 'DEAD-2' })]).expect(202);
      await AppDataSource.query(
        "UPDATE orders SET status='PROCESSING', lease_until = now() - interval '1 second' WHERE order_id='DEAD-2'",
      );
      await worker.runOnce();
      const view = (await getBatch(res.body.data.batchId)).body.data;
      expect(view).toMatchObject({ status: 'COMPLETED', failed: 1 });
      expect(view.orders[0]).toMatchObject({
        status: 'FAILED',
        error: { code: 'DISPATCH_INTERRUPTED' },
      });
      // and a person, having confirmed with the courier, can resubmit it
      await request(app)
        .post('/api/v1/orders')
        .send(createOrderBody({ order_id: 'DEAD-2' }))
        .expect(201);
    } finally {
      mock.idempotentOnReference = true;
    }
  });

  it('a partner disabled after submit fails that order with COURIER_UNAVAILABLE, not the batch', async () => {
    const res = await submit([
      createOrderBody({ order_id: 'GONE' }),
      createOrderBody({ order_id: 'FINE' }),
    ]).expect(202);
    await AppDataSource.query(
      "UPDATE orders SET courier_partner='delhivery' WHERE order_id='GONE'",
    );
    await drain();
    const byId = Object.fromEntries(
      (await getBatch(res.body.data.batchId)).body.data.orders.map((o: { orderId: string }) => [
        o.orderId,
        o,
      ]),
    );
    expect(byId['GONE']).toMatchObject({
      status: 'FAILED',
      error: { code: 'COURIER_UNAVAILABLE' },
    });
    expect(byId['FINE']).toMatchObject({ status: 'CREATED' });
  });
});

describe('GET /api/v1/batches/:batchId — states', () => {
  it('QUEUED → PROCESSING (live counts) → COMPLETED', async () => {
    const res = await submit(Array.from({ length: 25 }, () => createOrderBody())).expect(202);
    const id = res.body.data.batchId;
    expect((await getBatch(id)).body.data).toMatchObject({ status: 'QUEUED', pending: 25 });
    await worker.runOnce(); // 20 of 25
    expect((await getBatch(id)).body.data).toMatchObject({
      status: 'PROCESSING',
      succeeded: 20,
      pending: 5,
      failed: 0,
    });
    await drain();
    expect((await getBatch(id)).body.data).toMatchObject({
      status: 'COMPLETED',
      succeeded: 25,
      pending: 0,
    });
  });

  it('a batch where every order failed still COMPLETES, with reasons', async () => {
    const res = await submit([
      createOrderBody({ metadata: { mock: 'reject' } }),
      createOrderBody({ metadata: { mock: 'timeout' } }),
    ]).expect(202);
    await drain();
    const view = (await getBatch(res.body.data.batchId)).body.data;
    expect(view).toMatchObject({ status: 'COMPLETED', succeeded: 0, failed: 2, pending: 0 });
    expect(view.orders.map((o: { error: { code: string } }) => o.error.code).sort()).toEqual([
      'COURIER_REJECTED',
      'COURIER_TIMEOUT',
    ]);
  });
});

describe('GET /api/v1/batches/:batchId', () => {
  it('404 for an unknown batch, 400 for a malformed id', async () => {
    await getBatch('00000000-0000-4000-8000-000000000000').expect(404);
    await getBatch('nope').expect(400);
  });
});
