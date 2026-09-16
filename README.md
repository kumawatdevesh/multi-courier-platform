# Multi-Courier Integration Platform

One courier-agnostic REST API over many courier partners. UrbaneBolt is the first
integration; `mock` is a second adapter that exists to prove the plug-in design.

> Architecture, schema and trade-offs: **[DESIGN.md](./DESIGN.md)**

**Stack:** Node.js + TypeScript · Express · PostgreSQL + TypeORM · zod · pino · Vitest · Prettier

## Project structure

```
src/
├── app.ts
├── routes/
│   └── order.routes.ts               # the only place routes are declared
├── controllers/
│   ├── order.controller.ts
│   └── batch.controller.ts
├── services/
│   ├── order.service.ts              # courier-agnostic: no courier name appears here
│   └── batch.service.ts
├── jobs/
│   └── dispatch.worker.ts            # FOR UPDATE SKIP LOCKED poller
├── couriers/
│   ├── courier.interface.ts          # ← the CourierAdapter contract
│   ├── shipment.types.ts             # normalized model + ShipmentStatus
│   ├── courier.registry.ts           # register / resolve / list
│   ├── courier.loader.ts             # boot-time directory scan
│   ├── shared/                       # cross-cutting, written once for all partners
│   │   ├── http-client.ts            #   timeouts, retry, 401 replay, audit capture
│   │   ├── retry.ts                  #   exponential backoff + full jitter
│   │   ├── token-cache.ts            #   single-flight TTL cache
│   │   └── audit-trail.ts            #   carries the raw courier exchange to the service
│   ├── urbanebolt/
│   │   ├── urbanebolt.adapter.ts     #   default-exports the CourierFactory
│   │   ├── urbanebolt.client.ts      #   endpoints + payload shapes only
│   │   ├── urbanebolt.auth.ts
│   │   └── urbanebolt.status-map.ts  #   MAN → CREATED, CAN → CANCELLED, …
│   └── mock/
│       └── mock.adapter.ts           # bonus adapter; proves the plug-in design
├── models/                           # TypeORM entities
│   ├── order.model.ts
│   ├── tracking-history.model.ts     # append-only; no update path exists
│   └── batch.model.ts
├── dto/
│   ├── create-order.dto.ts           # zod — unified, courier-agnostic
│   ├── bulk-order.dto.ts
│   ├── order-id.dto.ts
│   └── response.dto.ts
├── errors/
│   ├── error-codes.ts                # the taxonomy + response envelope
│   ├── app-error.ts
│   └── courier-error.ts              # carries raw vendor payload, never serialized
├── middleware/
│   ├── request-id.ts
│   ├── validate.ts
│   └── error-handler.ts              # renders the one error shape
├── db/
│   ├── data-source.ts                # TypeORM DataSource, synchronize: false
│   └── migrations/                   # TypeORM migrations, checked into git
├── config/
│   └── index.ts                      # typed AppConfig + COURIER_<KEY>_* resolution
└── lib/
    └── logger.ts
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/orders` | create one shipment |
| `GET` | `/api/v1/orders/:orderId` | order + current status |
| `GET` | `/api/v1/orders/:orderId/track` | refreshes from courier, appends history |
| `POST` | `/api/v1/orders/:orderId/cancel` | |
| `POST` | `/api/v1/orders/bulk` | ≤100 orders → `202` + `batchId`, processed by the worker |
| `GET` | `/api/v1/batches/:batchId` | per-order `status` / `awb` / `error`, plus counts |
| `GET` | `/api/v1/couriers` | supported partners, from the registry |
| `GET` | `/health` | liveness + DB check |

Every request body carries `courier_partner`. The rest is our schema.

## Setup

```bash
cp .env.example .env        # fill in courier credentials
docker compose up -d db     # Postgres 16
npm install
npm run migration:run
npm run dev                 # API + bulk worker on :3000
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_URL` | — | Postgres connection string |
| `DB_POOL_SIZE` | `10` | TypeORM connection pool |
| `WORKER_ENABLED` | `true` | run the bulk dispatch worker in this process |
| `WORKER_POLL_MS` | `1000` | how often the worker looks for `PENDING` orders |
| `WORKER_BATCH_SIZE` | `20` | rows claimed per tick |
| `COURIER_CONCURRENCY` | `10` | max in-flight courier calls per partner per tick |
| `LOG_LEVEL` | `info` | |
| `COURIER_<KEY>_ENABLED` | `false` | registers the adapter at boot |
| `COURIER_<KEY>_BASE_URL` | — | |
| `COURIER_<KEY>_TIMEOUT_MS` | `15000` | |
| `COURIER_<KEY>_RETRY_ATTEMPTS` | `3` | on 5xx / timeout / network |
| `COURIER_<KEY>_RETRY_BASE_DELAY_MS` | `250` | exponential backoff + jitter |
| `COURIER_<KEY>_*` | — | anything else becomes `config.credentials` |

For UrbaneBolt that means `COURIER_URBANEBOLT_USERNAME`, `_PASSWORD`, `_CUSTOMER_CODE`.
Nothing is hardcoded; an unset required credential fails fast at boot, not at first request.

## Testing

```bash
npm test              # everything: 71 unit + 36 integration, ~2.5 s, no network
npm run test:unit     # retry, token cache, HTTP client (nock), UrbaneBolt mapping, DTOs, errors
npm run test:int      # real Express + Postgres, mock courier: orders, tracking, cancel, bulk, worker
npm run check         # typecheck (src + tests) + prettier --check + all tests
```

Integration tests need a database: `TEST_DATABASE_URL=postgres://…/multi_courier_test`
(defaults to `postgres:postgres@localhost`). They run the migrations and truncate between
tests. The `mock` adapter is steered by `metadata.mock` (`reject` · `timeout` · `duplicate` ·
`auth-fail`) and advances one lifecycle step per tracking poll.

## Adding a new courier

Three steps, no existing file changes:

1. **Create `src/couriers/<key>/<key>.adapter.ts`** whose default export is a
   `CourierFactory`. The filename is the convention the loader scans for:

   ```ts
   import type { CourierConfig, CourierFactory } from '../courier.interface';
   import { DelhiveryClient } from './delhivery.client';

   class DelhiveryAdapter implements CourierAdapter { /* … */ }

   const factory: CourierFactory = (config: CourierConfig) => new DelhiveryAdapter(config);
   export default factory;
   ```

2. **Implement the three `CourierAdapter` methods** (`createShipment` / `trackShipment` /
   `cancelShipment`), with the HTTP calls in `<key>.client.ts` and the vendor's status
   codes in `<key>.status-map.ts`. Build the client on `shared/http-client` so timeouts,
   retry and 401-replay come for free — do not hand-roll them. If the partner needs a
   token, build a `TokenCache` in `<key>.auth.ts` and pass it to the client; there is no
   `authenticate` method to implement.

3. **Set env vars** — `COURIER_DELHIVERY_ENABLED=true`, `_BASE_URL`, credentials — and
   restart.

The loader picks the directory up, the registry keys it, `GET /api/v1/couriers` lists it, and `courier_partner: "delhivery"` starts routing. Controllers, DTOs, services and the
other adapters are untouched.

## Assumptions

See DESIGN.md §7.
