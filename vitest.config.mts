import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database; running files serially keeps them isolated.
    fileParallelism: false,
    testTimeout: 15_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://postgres:postgres@localhost:5432/multi_courier_test',
      // The suite never talks to a real courier.
      COURIER_URBANEBOLT_ENABLED: 'false',
      COURIER_MOCK_ENABLED: 'true',
      COURIER_MOCK_BASE_URL: 'http://mock.courier.local',
      WORKER_LEASE_MS: '300',
      WORKER_HEARTBEAT_MS: '50',
    },
  },
});
