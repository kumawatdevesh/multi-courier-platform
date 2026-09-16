import type { CourierConfig } from '../couriers/courier.interface';

const DEFAULTS = {
  timeoutMs: 15_000,
  retryAttempts: 3,
  retryBaseDelayMs: 250,
} as const;

const RESERVED = new Set([
  'ENABLED',
  'BASE_URL',
  'TIMEOUT_MS',
  'RETRY_ATTEMPTS',
  'RETRY_BASE_DELAY_MS',
]);

function envPrefix(key: string): string {
  return `COURIER_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
}

function numberFrom(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

/** COURIER_<KEY>_* → CourierConfig. Unrecognised variables become camelCase credentials. */
export function loadCourierConfig(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): CourierConfig {
  const prefix = envPrefix(key);

  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || value === undefined) continue;
    const suffix = name.slice(prefix.length);
    if (RESERVED.has(suffix)) continue;
    credentials[toCamelCase(suffix)] = value;
  }

  const enabled = (env[`${prefix}ENABLED`] ?? 'false').toLowerCase() === 'true';
  const baseUrl = env[`${prefix}BASE_URL`] ?? '';

  if (enabled && !baseUrl) {
    throw new Error(`${prefix}BASE_URL is required when ${prefix}ENABLED is true`);
  }

  return {
    key: key.toLowerCase(),
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    timeoutMs: numberFrom(env[`${prefix}TIMEOUT_MS`], DEFAULTS.timeoutMs, `${prefix}TIMEOUT_MS`),
    retryAttempts: numberFrom(
      env[`${prefix}RETRY_ATTEMPTS`],
      DEFAULTS.retryAttempts,
      `${prefix}RETRY_ATTEMPTS`,
    ),
    retryBaseDelayMs: numberFrom(
      env[`${prefix}RETRY_BASE_DELAY_MS`],
      DEFAULTS.retryBaseDelayMs,
      `${prefix}RETRY_BASE_DELAY_MS`,
    ),
    credentials,
  };
}

function toCamelCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

export function requireCredential(config: CourierConfig, name: string): string {
  const value = config.credentials[name];
  if (!value) {
    const envVar = `${envPrefix(config.key)}${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
    throw new Error(`${envVar} is required for courier "${config.key}"`);
  }
  return value;
}
