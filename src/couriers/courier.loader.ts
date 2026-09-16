import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadCourierConfig } from '../config/couriers';
import { logger } from '../lib/logger';
import type { CourierFactory } from './courier.interface';
import { listCourierKeys, registerCourier } from './courier.registry';

const NON_COURIER_DIRS = new Set(['shared']);

/**
 * Registers every enabled `couriers/<key>/<key>.adapter.ts` at boot. A new partner is a
 * new directory plus env vars — no barrel file, no existing file edited.
 */
export async function loadCouriers(dir: string = __dirname): Promise<void> {
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NON_COURIER_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const key of candidates) {
    const config = loadCourierConfig(key);
    if (!config.enabled) {
      logger.info({ courier: key }, 'courier disabled by config, skipping');
      continue;
    }

    const modulePath = join(dir, key, `${key}.adapter`);
    if (!existsSync(`${modulePath}.ts`) && !existsSync(`${modulePath}.js`)) {
      logger.warn({ courier: key, modulePath }, 'no <key>.adapter file found, skipping');
      continue;
    }

    const mod = (await import(modulePath)) as { default?: CourierFactory };
    if (typeof mod.default !== 'function') {
      logger.warn({ courier: key }, 'adapter has no default CourierFactory export');
      continue;
    }

    registerCourier(mod.default(config));
    logger.info({ courier: key }, 'courier registered');
  }

  logger.info({ couriers: listCourierKeys() }, 'courier registry ready');
}
