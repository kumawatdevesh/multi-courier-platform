# API examples

**Postman:** import `multi-courier-platform.postman_collection.json` and
`local.postman_environment.json`. Run the folders top to bottom — the create requests store
`orderId` / `batchId` for the ones that follow. Every request carries assertions, so the
collection doubles as a smoke test: `npx newman run postman/*.collection.json -e postman/local.postman_environment.json`.

Requests use the `mock` courier so they work with no credentials. Switch `courier_partner`
to `urbanebolt` once `COURIER_URBANEBOLT_*` is set.

## curl

```bash
BASE=http://localhost:3000

# health + supported couriers
curl -s $BASE/health
curl -s $BASE/api/v1/couriers

# create
curl -s -X POST $BASE/api/v1/orders -H 'Content-Type: application/json' -d '{
  "order_id": "ORD-1001", "courier_partner": "mock",
  "payment_mode": "COD", "cod_amount": 499, "service_type": "SAME_DAY",
  "pickup": { "name": "Warehouse", "phone": "9876543210", "line1": "1 Industrial Rd",
              "city": "Gurgaon", "state": "Haryana", "pincode": "122001", "type": "SELLER" },
  "drop":   { "name": "Asha Rao", "phone": "9876543211", "line1": "12 MG Road",
              "city": "Bengaluru", "state": "Karnataka", "pincode": "560001" },
  "parcel": { "description": "Books", "weight_kg": 1.2, "length_cm": 30, "breadth_cm": 20,
              "height_cm": 10, "declared_value": 499 },
  "invoice": { "number": "INV-2026-001", "date": "2026-09-17", "value": 499 }
}'
# → 201 { "success": true, "data": { "id": "<uuid>", "awb": "MOCK0000000001", "status": "CREATED", … } }

ID=<uuid from above>
curl -s $BASE/api/v1/orders/$ID
curl -s $BASE/api/v1/orders/$ID/track          # re-run: history appends, never duplicates
curl -s -X POST $BASE/api/v1/orders/$ID/cancel

# errors — one envelope everywhere
curl -s $BASE/api/v1/orders/not-a-uuid          # 400 VALIDATION_ERROR  [orderId: must be a UUID]
curl -s -X POST $BASE/api/v1/orders -H 'Content-Type: application/json' \
  -d '{"order_id":"X","courier_partner":"delhivery"}'   # 400 UNKNOWN_COURIER + supported list

# bulk: 202 immediately, worker processes in the background
curl -s -X POST $BASE/api/v1/orders/bulk -H 'Content-Type: application/json' \
  -d '{ "orders": [ <order>, <order>, … up to 100 ] }'
# → 202 { "data": { "batchId": "<uuid>", "total": 100, "accepted": 99, "duplicates": [ … ] } }

curl -s $BASE/api/v1/batches/<batchId>          # poll until "status": "COMPLETED"
```

Add `-H 'X-Request-Id: my-trace-123'` to any request and the same id comes back in the
response header, the body, and every log line for that request.
