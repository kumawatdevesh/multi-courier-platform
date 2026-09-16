import { beforeEach, describe, expect, it } from 'vitest';

import type { CourierAdapter } from '../../src/couriers/courier.interface';
import {
  clearRegistry,
  findCourier,
  listCourierKeys,
  listCouriers,
  registerCourier,
} from '../../src/couriers/courier.registry';

const adapter = (key: string): CourierAdapter => ({
  key,
  displayName: key.toUpperCase(),
  createShipment: async () => ({ awb: 'x' }),
  trackShipment: async () => ({
    awb: 'x',
    status: 'CREATED',
    courierStatusCode: '',
    courierStatusText: '',
    events: [],
  }),
  cancelShipment: async () => ({ cancelled: true }),
});

describe('courier registry', () => {
  beforeEach(() => clearRegistry());

  it('finds a registered adapter case-insensitively', () => {
    registerCourier(adapter('urbanebolt'));
    expect(findCourier('UrbaneBolt')?.key).toBe('urbanebolt');
  });

  it('rejects duplicate registration loudly', () => {
    registerCourier(adapter('mock'));
    expect(() => registerCourier(adapter('MOCK'))).toThrow(/Duplicate courier registration/);
  });

  it("an unknown key is simply absent — what that means is the caller's decision", () => {
    registerCourier(adapter('mock'));
    expect(findCourier('nope')).toBeUndefined();
    expect(findCourier('mock')?.key).toBe('mock');
  });

  it('listCouriers reflects registrations in sorted order', () => {
    registerCourier(adapter('urbanebolt'));
    registerCourier(adapter('mock'));
    expect(listCourierKeys()).toEqual(['mock', 'urbanebolt']);
    expect(listCouriers()).toEqual([
      { key: 'mock', displayName: 'MOCK' },
      { key: 'urbanebolt', displayName: 'URBANEBOLT' },
    ]);
  });
});
