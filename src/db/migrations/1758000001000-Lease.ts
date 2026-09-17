import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Lease1758000001000 implements MigrationInterface {
  name = 'Lease1758000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN "lease_until" timestamptz`);
    // The worker's claim: PENDING rows, or PROCESSING rows whose lease has lapsed.
    await queryRunner.query(
      `CREATE INDEX "idx_orders_lease" ON "orders" ("status", "lease_until")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_orders_lease"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "lease_until"`);
  }
}
