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
      COURIER_URBANEBOLT_ENABLED: 'true',
      COURIER_URBANEBOLT_BASE_URL: 'https://courier.test',
      COURIER_URBANEBOLT_USERNAME: 'test',
      COURIER_URBANEBOLT_PASSWORD: 'test',
      COURIER_URBANEBOLT_CUSTOMER_CODE: 'TEST1',
      COURIER_URBANEBOLT_RETRY_ATTEMPTS: '2',
      COURIER_URBANEBOLT_RETRY_BASE_DELAY_MS: '1',
      COURIER_MOCK_ENABLED: 'true',
      COURIER_MOCK_BASE_URL: 'http://mock.courier.local',
      WORKER_LEASE_MS: '300',
      WORKER_HEARTBEAT_MS: '50',
    },
  },
});
