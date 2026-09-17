# DESIGN.md — Multi-Courier Integration Platform

## 1. Architecture

```
routes → controllers → services → courier.registry → adapter  →  courier HTTP API
 dto/     order         order.service   findCourier()    urbanebolt/       ↑
 zod      batch         batch.service   list()           mock/          shared/
                              │                                         http-client
                              ↓                                         retry
                  Postgres (orders · tracking_history · batches)        token-cache
                              ↑
                  jobs/dispatch.worker   (FOR UPDATE SKIP LOCKED)
```

Services speak only the normalized model (`couriers/shipment.types.ts`) and the
`CourierAdapter` interface: no courier name, no `switch`, no `if`.

## 2. Pattern: Adapter + self-registering Registry

**Adapter** puts each vendor API behind one three-method interface (`createShipment` /
`trackShipment` / `cancelShipment`; auth is adapter-private via `TokenCache`). **Registry**
is a runtime map populated by a boot-time directory scan of `couriers/<key>/<key>.adapter.ts`.

A barrel file (`export * from './delhivery'`) would still be an edit to an existing file,
which §3.2 forbids. With the scan, **adding Delhivery = a new directory + `COURIER_DELHIVERY_*`
env vars.** Zero diffs elsewhere; `GET /couriers` and the unknown-courier 400 read the same
map, so both stay correct for free.

Cross-cutting concerns live once in `couriers/shared/`: `http-client` (timeouts, request-id
propagation, raw request/response capture), `retry` (exponential backoff + full jitter,
configurable), `token-cache` (single-flight, early expiry; on 401 the client invalidates,
re-authenticates and replays exactly once). An adapter author writes mapping only.

## 3. Normalized model & the UrbaneBolt mapping

| Ours | UrbaneBolt (`POST /services/manifest/`) |
|---|---|
| `orderId` | `orderNumber` |
| `pickup` / `drop` / `returnTo` (defaults to `pickup`) | `shpr*` / `cons*` / `rtn*` |
| `parcel.{weightKg,lengthCm,…}` | `weight`, `length`, `breadth`, `height`, `pieces` |
| `paymentMode` PREPAID/COD, `codAmount` | `payMode` PPD/COD, `collectableValue` |
| ← `successResponse[0].awbNumber` | AWB — a JSON **number**, stored as text |

Statuses map through a per-adapter table (`<key>.status-map.ts`) into `PENDING · PROCESSING ·
CREATED · PICKED_UP · IN_TRANSIT · OUT_FOR_DELIVERY · DELIVERED · RTO · CANCELLED · FAILED`.
An unmapped code yields `status: null`: the scan is stored with its raw code, the order keeps
its previous status, a warning is logged — never guessed, never dropped.

**Critical quirk, verified against UAT:** UrbaneBolt returns **HTTP 200 for business
failures** — `{"status":"Failed","message":"Data Not Found"}`, and a duplicate order comes
back as 200 with the order in `errorResponse[]`. Branching on HTTP status alone records
failed shipments as successes, so the adapter classifies the envelope and that outcome — not
the status code — drives retry and persistence.

## 4. Database schema

TypeORM, `synchronize: false` everywhere; schema changes go through `db/migrations/`.

**`orders`** — `id uuid pk`, `order_id text UNIQUE` (the caller's id, the idempotency
anchor), `batch_id fk NULL`, `courier_partner`, `courier_order_id`, `awb`, `label_url`,
`route_code`, `status`, `normalized_payload`, `request_payload`, `response_payload`,
`last_error` (all jsonb), `attempt_count`, `lease_until`, `created_at`, `updated_at`. Indexes
on `awb`, `batch_id`, `(status, updated_at)`, `(status, lease_until)`.

`INSERT … ON CONFLICT (order_id) DO NOTHING` is what makes a repeated submission safe across
concurrent requests and inside a bulk payload — no read-then-write race, no lock. `awb` is
text (other partners issue alphanumeric waybills); `status` and `courier_partner` are varchar,
not enums, so a new value never needs `ALTER TYPE`. `request_payload`/`response_payload` hold
the **create** call; track and cancel are audited in `tracking_history` and `last_error`.

**`tracking_history`** — append-only: `order_id fk`, `status` (nullable), `courier_status_code`,
`courier_status_text`, `location`, `status_timestamp`, `raw_payload`, `created_at`. Two
timestamps because couriers backfill scans late and reconciliation must tell "happened late"
from "arrived late". `UNIQUE (order_id, courier_status_code, status_timestamp)` makes polling
idempotent: the courier returns its whole scan list each call and writers use `.orIgnore()`.

**`batches`** — `id`, `total`, `accepted`, `status` (`QUEUED · PROCESSING · COMPLETED`),
`created_at`, `completed_at`. Per-order outcomes are read from the child orders, so there is
one source of truth and no counter for the worker to keep in sync.

## 5. Bulk: 202 + batch_id, Postgres as the queue

`POST /orders/bulk` validates all ≤100 orders and resolves every partner *before* writing,
inserts the batch and its orders as `PENDING` in one transaction, and returns **202** with
`batch_id` — 41 ms for 100 orders in the live run, no courier contacted.

A worker in the same process polls every `WORKER_POLL_MS`:

```sql
UPDATE orders SET status = 'PROCESSING', lease_until = now() + :lease
WHERE id IN (SELECT id FROM orders
             WHERE status = 'PENDING' OR (status = 'PROCESSING' AND lease_until < now())
             ORDER BY created_at LIMIT :n FOR UPDATE SKIP LOCKED)
RETURNING *
```

`SKIP LOCKED` gives concurrent workers disjoint chunks with no coordination. Claimed rows are
grouped by partner and dispatched with ≤`COURIER_CONCURRENCY` calls in flight per partner,
through the same `OrderService.dispatch()` the single-create path uses. A batch is
`COMPLETED` when none of its orders remain in flight; `GET /batches/:id` lists per-order
`status`, `awb` and `error.code`.

**Ownership is a lease, not a lock.** The row lock lives only for the claim statement —
milliseconds — because a Postgres lock dies with its connection and so cannot represent
work in progress across a crash. What does is `lease_until`: the claim sets it
`WORKER_LEASE_MS` ahead, and `dispatch()` heartbeats it every `WORKER_HEARTBEAT_MS` for as
long as the courier call runs, so a slow call is never mistaken for a dead worker. The
single-create path takes the same lease, so an inline dispatch is invisible to the worker
and equally recoverable. A lease that lapses means the worker stopped heartbeating — it died
mid-call.

**Crash recovery.** The courier call ran outside any lock (at-most-once), so a lapsed lease
raises one question nobody local can answer: did the call reach the courier? The adapter
decides what is safe. A partner that rejects a repeated reference
(`idempotentOnReference: true` — UrbaneBolt does, verified in UAT) is re-dispatched
automatically: the outcome is `CREATED` if the call never landed, or `FAILED /
DUPLICATE_ORDER` if it did — the shipment exists, and its AWB needs a manual lookup. A
partner without that guarantee is marked `FAILED / DISPATCH_INTERRUPTED` instead, because a
retry could genuinely ship twice. Either way the batch completes and the order is visible
with a reason. Resubmitting any `FAILED` `order_id` retries it, atomically
(`UPDATE … WHERE status = 'FAILED'`), so concurrent resubmits produce one dispatch.

**Trade-offs.** 202 over synchronous: 100 orders at ~2 s, 10 in parallel, is ~20 s — past
gateway timeouts, and a courier outage would pin the request. Postgres `SKIP LOCKED` over
BullMQ/Redis: no extra service and the job *is* the order row (no dual-write), at the cost of
~1 s poll latency, irrelevant at this volume. Rejected streaming (NDJSON): pins a connection
and loses results on disconnect. In-process worker: one thing to run; `WORKER_ENABLED=false`
on API replicas plus a worker-only replica is the split when scale demands it.

## 6. Errors

One shape from every endpoint, rendered by a single error middleware:

```json
{ "success": false,
  "error": { "code": "COURIER_REJECTED", "message": "Courier rejected the request",
             "details": [{ "field": "drop.pincode", "message": "must be 6 digits" }],
             "requestId": "req_01J8…", "timestamp": "2026-09-16T12:30:43Z" } }
```

`VALIDATION_ERROR` · `UNKNOWN_COURIER` (lists supported couriers) · `DUPLICATE_ORDER` ·
`INVALID_ORDER_STATE` · `ORDER_NOT_FOUND` · `COURIER_AUTH_FAILED` · `COURIER_REJECTED`
(courier 4xx or failure envelope — vendor text stays in `last_error`, never in the response)
· `COURIER_UNAVAILABLE` / `COURIER_TIMEOUT` (after retries; row persisted `FAILED`) ·
`DISPATCH_INTERRUPTED` (worker crash; see §5) ·
`RATE_LIMITED` · `PAYLOAD_TOO_LARGE` · `INTERNAL_ERROR`. Every failure logs
`{ requestId, orderId, courierPartner, errorCode, errorType, durationMs }`, with a stack for
5xx and the wrapped `cause` for foreign errors — not for deliberate 4xx, where it is noise.

## 7. Assumptions & trade-offs

- Credentials are per-partner, not per-seller; multi-tenant keys would need a `courier_accounts` table.
- Token cache is in-process; Redis-backed when instance count grows. No `cluster` mode: the
  service is I/O-bound, so extra processes would idle while multiplying the DB pool and
  splitting the single-flight cache. Scale is horizontal replicas.
- Status is refreshed by polling `GET /track`; a webhook route would reuse the same
  `tracking_history` writer.
- `customerCode` is UrbaneBolt-specific and lives in that adapter's config, not the DTO.
