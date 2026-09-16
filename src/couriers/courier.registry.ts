import type { CourierAdapter } from './courier.interface';

/**
 * Populated by courier.loader.ts at boot, so adding a partner changes nothing here. A
 * missing key means different things depending on where it came from, so the service —
 * not the registry — decides which error to raise.
 */
const adapters = new Map<string, CourierAdapter>();

const normalizeKey = (key: string): string => key.toLowerCase();

export function registerCourier(adapter: CourierAdapter): void {
  const key = normalizeKey(adapter.key);
  if (adapters.has(key)) {
    throw new Error(`Duplicate courier registration for key "${key}"`);
  }
  adapters.set(key, adapter);
}

export function findCourier(key: string): CourierAdapter | undefined {
  return adapters.get(normalizeKey(key));
}

export function listCourierKeys(): string[] {
  return [...adapters.keys()].sort();
}

export function listCouriers(): Array<{ key: string; displayName: string }> {
  return [...adapters.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, displayName }) => ({ key, displayName }));
}

export function clearRegistry(): void {
  adapters.clear();
}
