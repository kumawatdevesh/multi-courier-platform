import { describe, expect, it, vi } from 'vitest';

import { withRetry } from '../../src/couriers/shared/retry';

const opts = (overrides = {}) => ({
  attempts: 3,
  baseDelayMs: 1,
  isRetryable: () => true,
  context: {},
  ...overrides,
});

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, opts())).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure up to the attempt budget, then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, opts())).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last attempt and throws the final error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still down'));
    await expect(withRetry(fn, opts())).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable failure', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('400'));
    await expect(withRetry(fn, opts({ isRetryable: () => false }))).rejects.toThrow('400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the attempt number so callers can log it', async () => {
    const seen: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new Error('retry');
      return 'ok';
    });
    await withRetry(fn, opts());
    expect(seen).toEqual([1, 2, 3]);
  });

  it('attempts: 1 disables retrying entirely', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('once'));
    await expect(withRetry(fn, opts({ attempts: 1 }))).rejects.toThrow('once');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
