import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenCache } from '../../src/couriers/shared/token-cache';

describe('TokenCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('issues once and serves the cached token afterwards', async () => {
    const issue = vi.fn().mockResolvedValue({ token: 'T1', expiresInSec: 3600 });
    const cache = new TokenCache(issue, { courierKey: 'x' });

    expect(await cache.get()).toBe('T1');
    expect(await cache.get()).toBe('T1');
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('single-flight: concurrent callers share one authentication', async () => {
    let resolveIssue!: (v: { token: string; expiresInSec: number }) => void;
    const issue = vi.fn(
      () => new Promise<{ token: string; expiresInSec: number }>((r) => (resolveIssue = r)),
    );
    const cache = new TokenCache(issue, { courierKey: 'x' });

    const inFlight = Promise.all([cache.get(), cache.get(), cache.get()]);
    resolveIssue({ token: 'T1', expiresInSec: 3600 });

    expect(await inFlight).toEqual(['T1', 'T1', 'T1']);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('re-issues once the token is past its skew-adjusted expiry', async () => {
    const issue = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', expiresInSec: 120 })
      .mockResolvedValueOnce({ token: 'T2', expiresInSec: 120 });
    const cache = new TokenCache(issue, { courierKey: 'x', skewMs: 60_000 });

    expect(await cache.get()).toBe('T1');
    vi.advanceTimersByTime(59_000); // 120s lifetime - 60s skew = 60s usable
    expect(await cache.get()).toBe('T1');
    vi.advanceTimersByTime(2_000);
    expect(await cache.get()).toBe('T2');
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a fresh issue on the next get()', async () => {
    const issue = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', expiresInSec: 3600 })
      .mockResolvedValueOnce({ token: 'T2', expiresInSec: 3600 });
    const cache = new TokenCache(issue, { courierKey: 'x' });

    expect(await cache.get()).toBe('T1');
    cache.invalidate();
    expect(await cache.get()).toBe('T2');
  });

  it('a failed issue does not poison the cache; the next get() retries', async () => {
    const issue = vi
      .fn()
      .mockRejectedValueOnce(new Error('auth down'))
      .mockResolvedValueOnce({ token: 'T1', expiresInSec: 3600 });
    const cache = new TokenCache(issue, { courierKey: 'x' });

    await expect(cache.get()).rejects.toThrow('auth down');
    expect(await cache.get()).toBe('T1');
  });
});
