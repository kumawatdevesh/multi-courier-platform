import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1758000000000 implements MigrationInterface {
  name = 'Init1758000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "batches" (
        "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "total"        integer NOT NULL,
        "accepted"     integer NOT NULL DEFAULT 0,
        "status"       varchar(16) NOT NULL DEFAULT 'QUEUED',
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "order_id"           text NOT NULL,
        "batch_id"           uuid REFERENCES "batches"("id") ON DELETE SET NULL,
        "courier_partner"    text NOT NULL,
        "courier_order_id"   text,
        "awb"                text,
        "label_url"          text,
        "route_code"         text,
        "status"             varchar(32) NOT NULL DEFAULT 'PENDING',
        "normalized_payload" jsonb NOT NULL,
        "request_payload"    jsonb,
        "response_payload"   jsonb,
        "last_error"         jsonb,
        "attempt_count"      integer NOT NULL DEFAULT 0,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Idempotency anchor.
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_orders_order_id" ON "orders" ("order_id")`);
    await queryRunner.query(`CREATE INDEX "idx_orders_awb" ON "orders" ("awb")`);
    // The worker's claim query and the reconciliation sweep both key on this.
    await queryRunner.query(
      `CREATE INDEX "idx_orders_status_updated" ON "orders" ("status", "updated_at")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_orders_batch" ON "orders" ("batch_id")`);

    await queryRunner.query(`
      CREATE TABLE "tracking_history" (
        "id"                  bigserial PRIMARY KEY,
        "order_id"            uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
        "status"              varchar(32),
        "courier_status_code" text NOT NULL,
        "courier_status_text" text,
        "location"            text,
        "status_timestamp"    timestamptz NOT NULL,
        "raw_payload"         jsonb NOT NULL,
        "created_at"          timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Makes re-polling idempotent; writers use ON CONFLICT DO NOTHING.
    await queryRunner.query(`
      ALTER TABLE "tracking_history"
        ADD CONSTRAINT "uq_tracking_event"
        UNIQUE ("order_id", "courier_status_code", "status_timestamp")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_tracking_order_time"
        ON "tracking_history" ("order_id", "status_timestamp" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tracking_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "batches"`);
  }
}
