import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dedupe on the whole scan, not just code + time: the same code can legitimately recur in
 * the same minute at a different hub. Location and text become NOT NULL so they can take
 * part in the constraint (Postgres treats NULL <> NULL in a UNIQUE index).
 */
export class TrackingDedupe1758000002000 implements MigrationInterface {
  name = 'TrackingDedupe1758000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tracking_history" SET "location" = '' WHERE "location" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "tracking_history" SET "courier_status_text" = '' WHERE "courier_status_text" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "tracking_history"
         ALTER COLUMN "location" SET DEFAULT '', ALTER COLUMN "location" SET NOT NULL,
         ALTER COLUMN "courier_status_text" SET DEFAULT '', ALTER COLUMN "courier_status_text" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "tracking_history" DROP CONSTRAINT "uq_tracking_event"`);
    await queryRunner.query(
      `ALTER TABLE "tracking_history" ADD CONSTRAINT "uq_tracking_event"
         UNIQUE ("order_id", "courier_status_code", "status_timestamp", "location", "courier_status_text")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tracking_history" DROP CONSTRAINT "uq_tracking_event"`);
    await queryRunner.query(
      `ALTER TABLE "tracking_history" ADD CONSTRAINT "uq_tracking_event"
         UNIQUE ("order_id", "courier_status_code", "status_timestamp")`,
    );
    await queryRunner.query(
      `ALTER TABLE "tracking_history"
         ALTER COLUMN "location" DROP NOT NULL, ALTER COLUMN "location" DROP DEFAULT,
         ALTER COLUMN "courier_status_text" DROP NOT NULL, ALTER COLUMN "courier_status_text" DROP DEFAULT`,
    );
  }
}
