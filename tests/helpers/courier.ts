import nock from 'nock';
import { afterAll, afterEach, beforeAll } from 'vitest';

import type {
  AuditEntry,
  CourierConfig,
  CourierContext,
} from '../../src/couriers/courier.interface';
import { AUTH_PATH } from '../../src/couriers/urbanebolt/urbanebolt.auth';
import type { Address, NormalizedOrder } from '../../src/couriers/shipment.types';

export const BASE = 'https://courier.test';

export function courierConfig(overrides: Partial<CourierConfig> = {}): CourierConfig {
  return {
    key: 'urbanebolt',
    enabled: true,
    baseUrl: BASE,
    timeoutMs: 500,
    retryAttempts: 3,
    retryBaseDelayMs: 1,
    credentials: { username: 'u', password: 'p', customerCode: 'CUST1' },
    ...overrides,
  };
}

/** Records every audit entry (AuditTrail keeps only the last). */
export function testContext(orderId = 'ORD-1'): { ctx: CourierContext; audits: AuditEntry[] } {
  const audits: AuditEntry[] = [];
  return { ctx: { requestId: 'req-test', orderId, audit: (entry) => audits.push(entry) }, audits };
}

export function useNock(): void {
  beforeAll(() => nock.disableNetConnect());
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());
}

export function stubAuth(token = 'TOK') {
  return nock(BASE).post(AUTH_PATH).reply(200, {
    access_token: token,
    expires_in: 86400,
    token_type: 'Bearer',
    status: 'Success',
  });
}

export function address(overrides: Partial<Address> = {}): Address {
  return {
    name: 'Asha Rao',
    phone: '9876543210',
    email: 'asha@example.com',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    country: 'INDIA',
    type: 'HOME',
    ...overrides,
  };
}

const parcel = {
  description: 'Books',
  weightKg: 1.2,
  lengthCm: 30,
  breadthCm: 20,
  heightCm: 10,
  pieces: 1,
  declaredValue: 499,
};
const invoice = { number: 'INV-1', date: '2026-09-16', value: 499 };

export function normalizedOrder(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    orderId: 'ORD-1',
    paymentMode: 'COD',
    codAmount: 499,
    serviceType: 'SAME_DAY',
    pickup: address({ name: 'Warehouse', type: 'SELLER', pincode: '122001' }),
    drop: address(),
    parcel,
    invoice,
    ...overrides,
  };
}

/** Wire shape, from the same values as normalizedOrder(). */
export function createOrderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const wireAddress = ({ line1, line2, ...rest }: Address) => ({
    line1,
    ...(line2 && { line2 }),
    ...rest,
  });
  return {
    order_id: `ORD-${Math.random().toString(36).slice(2, 10)}`,
    courier_partner: 'mock',
    payment_mode: 'COD',
    cod_amount: 499,
    pickup: wireAddress(address({ name: 'Warehouse', type: 'SELLER', pincode: '122001' })),
    drop: wireAddress(address()),
    parcel: {
      description: parcel.description,
      weight_kg: parcel.weightKg,
      length_cm: parcel.lengthCm,
      breadth_cm: parcel.breadthCm,
      height_cm: parcel.heightCm,
      declared_value: parcel.declaredValue,
    },
    invoice,
    ...overrides,
  };
}
