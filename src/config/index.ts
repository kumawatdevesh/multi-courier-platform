import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(20),
  COURIER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  RECONCILE_STUCK_AFTER_MS: z.coerce.number().int().positive().default(300_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  logLevel: parsed.data.LOG_LEVEL,
  databaseUrl: parsed.data.DATABASE_URL,
  dbPoolSize: parsed.data.DB_POOL_SIZE,
  worker: {
    enabled: parsed.data.WORKER_ENABLED === 'true',
    pollMs: parsed.data.WORKER_POLL_MS,
    batchSize: parsed.data.WORKER_BATCH_SIZE,
    concurrencyPerPartner: parsed.data.COURIER_CONCURRENCY,
    stuckAfterMs: parsed.data.RECONCILE_STUCK_AFTER_MS,
  },
} as const;
