import { logger } from '../../lib/logger';

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  isRetryable: (error: unknown) => boolean;
  context: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter — random(0, base·2^n), capped — so a burst of
 * failures does not retry in lockstep and reproduce the overload.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxDelay = opts.maxDelayMs ?? 10_000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= opts.attempts || !opts.isRetryable(error)) {
        throw error;
      }

      const ceiling = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), maxDelay);
      const delayMs = Math.round(Math.random() * ceiling);

      logger.warn(
        {
          ...opts.context,
          attempt,
          remaining: opts.attempts - attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        },
        'courier call failed, retrying',
      );

      await sleep(delayMs);
    }
  }
}
