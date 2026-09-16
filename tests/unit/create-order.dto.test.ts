import { describe, expect, it } from 'vitest';

import { createOrderSchema, toNormalizedOrder } from '../../src/dto/create-order.dto';
import { createOrderBody } from '../helpers/courier';

// Optional address fields omitted so defaults are exercised.
const valid = () => {
  const body = createOrderBody({ order_id: 'ORD-1' }) as Record<string, any>;
  for (const side of ['pickup', 'drop']) {
    delete body[side].email;
    delete body[side].country;
    delete body[side].type;
  }
  return body;
};

const issues = (body: unknown) => {
  const r = createOrderSchema.safeParse(body);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('createOrderSchema', () => {
  it('accepts a valid payload and applies defaults', () => {
    const r = createOrderSchema.safeParse(valid());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.pickup.country).toBe('INDIA');
      expect(r.data.pickup.type).toBe('HOME');
      expect(r.data.parcel.pieces).toBe(1);
    }
  });

  it('reports every problem at once, with field paths', () => {
    const body = valid();
    body.pickup.phone = '123';
    body.drop.pincode = '12';
    body.invoice = { ...body.invoice, date: '16/09/2026' };
    expect(issues(body)).toEqual([
      'pickup.phone: must be a 10-digit mobile number',
      'drop.pincode: must be a 6-digit pincode',
      'invoice.date: must be an ISO date (YYYY-MM-DD)',
    ]);
  });

  it('COD requires a positive cod_amount', () => {
    expect(issues({ ...valid(), cod_amount: undefined })).toEqual([
      'cod_amount: must be greater than 0 when payment_mode is COD',
    ]);
    expect(issues({ ...valid(), cod_amount: 0 })).toEqual([
      'cod_amount: must be greater than 0 when payment_mode is COD',
    ]);
  });

  it('PREPAID rejects a cod_amount', () => {
    expect(issues({ ...valid(), payment_mode: 'PREPAID', cod_amount: 5 })).toEqual([
      'cod_amount: must not be set when payment_mode is PREPAID',
    ]);
  });

  it('does not validate courier_partner against a list — the registry does that', () => {
    expect(issues({ ...valid(), courier_partner: 'anything' })).toEqual([]);
  });
});

describe('toNormalizedOrder', () => {
  it('translates snake_case wire fields to the internal model', () => {
    const parsed = createOrderSchema.parse({
      ...valid(),
      service_type: 'SAME_DAY',
      metadata: { mock: 'reject' },
    });
    const order = toNormalizedOrder(parsed);
    expect(order).toMatchObject({
      orderId: 'ORD-1',
      paymentMode: 'COD',
      codAmount: 499,
      serviceType: 'SAME_DAY',
      parcel: {
        weightKg: 1.2,
        lengthCm: 30,
        breadthCm: 20,
        heightCm: 10,
        declaredValue: 499,
        pieces: 1,
      },
      invoice: { number: 'INV-1', date: '2026-09-16', value: 499 },
      metadata: { mock: 'reject' },
    });
    expect(order.returnTo).toBeUndefined();
  });
});
