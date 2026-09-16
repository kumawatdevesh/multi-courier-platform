import { logger } from '../../lib/logger';

export interface IssuedToken {
  token: string;
  expiresInSec: number;
}

/**
 * Single-flight (concurrent misses share one login) and expires `skewMs` early so a token
 * never dies in transit. The HTTP client calls invalidate() on a 401.
 */
export class TokenCache {
  private token: string | null = null;
  private expiresAtMs = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly issue: () => Promise<IssuedToken>,
    private readonly opts: { courierKey: string; skewMs?: number } = { courierKey: 'unknown' },
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAtMs) {
      return this.token;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.issue()
      .then(({ token, expiresInSec }) => {
        const skewMs = this.opts.skewMs ?? 60_000;
        this.token = token;
        this.expiresAtMs = Date.now() + Math.max(expiresInSec * 1000 - skewMs, 0);
        logger.info({ courier: this.opts.courierKey, expiresInSec }, 'courier token issued');
        return token;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }
}
