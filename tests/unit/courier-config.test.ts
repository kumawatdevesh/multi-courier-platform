import { describe, expect, it } from 'vitest';

import { loadCourierConfig, requireCredential } from '../../src/config/couriers';

describe('loadCourierConfig', () => {
  it('reads the framework settings and defaults the rest', () => {
    const cfg = loadCourierConfig('urbanebolt', {
      COURIER_URBANEBOLT_ENABLED: 'true',
      COURIER_URBANEBOLT_BASE_URL: 'https://uat.urbanebolt.in/',
    });
    expect(cfg).toMatchObject({
      key: 'urbanebolt',
      enabled: true,
      baseUrl: 'https://uat.urbanebolt.in',
      timeoutMs: 15_000,
      retryAttempts: 3,
      retryBaseDelayMs: 250,
    });
  });

  it('collects every non-framework COURIER_<KEY>_* var as a camelCase credential', () => {
    const cfg = loadCourierConfig('delhivery', {
      COURIER_DELHIVERY_ENABLED: 'true',
      COURIER_DELHIVERY_BASE_URL: 'https://x',
      COURIER_DELHIVERY_API_TOKEN: 'abc',
      COURIER_DELHIVERY_WAREHOUSE_NAME: 'BLR-1',
      COURIER_URBANEBOLT_USERNAME: 'not-mine',
      UNRELATED: 'x',
    });
    expect(cfg.credentials).toEqual({ apiToken: 'abc', warehouseName: 'BLR-1' });
  });

  it('is disabled by default and does not require a base URL when disabled', () => {
    expect(loadCourierConfig('mock', {}).enabled).toBe(false);
  });

  it('an enabled courier without a base URL fails at load time', () => {
    expect(() => loadCourierConfig('mock', { COURIER_MOCK_ENABLED: 'true' })).toThrow(
      /COURIER_MOCK_BASE_URL is required/,
    );
  });

  it('rejects non-numeric timeouts and retry counts', () => {
    expect(() => loadCourierConfig('mock', { COURIER_MOCK_TIMEOUT_MS: 'soon' })).toThrow(
      /positive number/,
    );
    expect(() => loadCourierConfig('mock', { COURIER_MOCK_RETRY_ATTEMPTS: '-1' })).toThrow(
      /positive number/,
    );
  });

  it('requireCredential names the exact env var that is missing', () => {
    const cfg = loadCourierConfig('urbanebolt', { COURIER_URBANEBOLT_USERNAME: 'u' });
    expect(requireCredential(cfg, 'username')).toBe('u');
    expect(() => requireCredential(cfg, 'customerCode')).toThrow(
      'COURIER_URBANEBOLT_CUSTOMER_CODE is required for courier "urbanebolt"',
    );
  });
});
