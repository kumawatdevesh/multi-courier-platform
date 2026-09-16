import nock from 'nock';
import { describe, expect, it } from 'vitest';

import factory, { parseScanDate } from '../../src/couriers/urbanebolt/urbanebolt.adapter';
import { PATHS } from '../../src/couriers/urbanebolt/urbanebolt.client';
import { toShipmentStatus } from '../../src/couriers/urbanebolt/urbanebolt.status-map';
import {
  BASE,
  courierConfig,
  normalizedOrder,
  stubAuth,
  testContext,
  useNock,
} from '../helpers/courier';

describe('UrbaneBoltAdapter', () => {
  useNock();

  it('fails at construction, not first request, when customerCode is missing', () => {
    expect(() => factory(courierConfig({ credentials: { username: 'u', password: 'p' } }))).toThrow(
      /COURIER_URBANEBOLT_CUSTOMER_CODE is required/,
    );
  });

  describe('createShipment → manifest payload', () => {
    async function captureManifest(order = normalizedOrder()) {
      let sent: Record<string, unknown>[] = [];
      stubAuth();
      nock(BASE)
        .post(PATHS.manifest, (body) => {
          sent = body;
          return true;
        })
        .reply(200, {
          status: 'Success',
          successResponse: [
            {
              status: 'Success',
              orderNumber: order.orderId,
              awbNumber: 200000007895,
              routeCode: 'GGN/DLHH',
              shippingLabel: 'https://label',
            },
          ],
          errorResponse: [],
        });
      const { ctx } = testContext();
      const result = await factory(courierConfig()).createShipment(order, ctx);
      return { result, payload: sent[0]! };
    }

    it('maps the normalized order to UrbaneBolt field names', async () => {
      const { payload } = await captureManifest();
      expect(payload).toMatchObject({
        customerCode: 'CUST1',
        orderNumber: 'ORD-1',
        payMode: 'COD',
        collectableValue: 499,
        serviceType: 'SDD',
        weight: 1.2,
        length: 30,
        breadth: 20,
        height: 10,
        pieces: 1,
        declaredValue: 499,
        itemDescription: 'Books',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-09-16',
        invoiceValue: 499,
        shprName: 'Warehouse',
        shprAddressType: 'Seller',
        shprPincode: 122001,
        consName: 'Asha Rao',
        consAddressType: 'Home',
        consPincode: 560001,
        consMobile: 9876543210,
      });
    });

    it('sends the array shape the manifest endpoint requires', async () => {
      let raw: unknown;
      stubAuth();
      nock(BASE)
        .post(PATHS.manifest, (b) => {
          raw = b;
          return true;
        })
        .reply(200, {
          status: 'Success',
          successResponse: [{ orderNumber: 'ORD-1', awbNumber: 1 }],
          errorResponse: [],
        });
      await factory(courierConfig()).createShipment(normalizedOrder(), testContext().ctx);
      expect(Array.isArray(raw)).toBe(true);
    });

    it('PREPAID → payMode PPD with collectableValue 0', async () => {
      const { payload } = await captureManifest(
        normalizedOrder({ paymentMode: 'PREPAID', codAmount: undefined }),
      );
      expect(payload).toMatchObject({ payMode: 'PPD', collectableValue: 0 });
    });

    it('returnTo defaults to pickup when omitted', async () => {
      const { payload } = await captureManifest(normalizedOrder({ returnTo: undefined }));
      expect(payload.rtnName).toBe(payload.shprName);
      expect(payload.rtnPincode).toBe(payload.shprPincode);
    });

    it('joins line1 and line2 into a single address', async () => {
      const order = normalizedOrder();
      order.drop.line2 = 'Near Park';
      const { payload } = await captureManifest(order);
      expect(payload.consAddress).toBe('12 MG Road, Near Park');
    });

    it('stringifies the numeric awbNumber; courierOrderId is null since UrbaneBolt mints none', async () => {
      const { result } = await captureManifest();
      expect(result).toEqual({
        courierOrderId: null,
        awb: '200000007895',
        labelUrl: 'https://label',
        routeCode: 'GGN/DLHH',
      });
      expect(typeof result.awb).toBe('string');
    });
  });

  describe('trackShipment', () => {
    it('normalizes scans, oldest first, with raw codes preserved', async () => {
      stubAuth();
      nock(BASE)
        .get(PATHS.tracking)
        .query({ awb: '1' })
        .reply(200, {
          status: 'Success',
          data: {
            awbNumber: 1,
            currentStatusCode: 'CAN',
            currentStatusCodeDescription: 'Cancelled',
            currentLocation: 'Gurgaon',
            edd: '2026-09-18',
            scans: [
              {
                statusDateTime: '03 May 2025, 15:47',
                statusCode: 'CAN',
                statusCodeDescription: 'Cancelled',
                currentLocation: '',
              },
              {
                statusDateTime: '03 May 2025, 15:44',
                statusCode: 'MAN',
                statusCodeDescription: 'Shipment Manifested',
                currentLocation: 'Gurgaon',
              },
            ],
          },
        });
      const { ctx } = testContext();
      const result = await factory(courierConfig()).trackShipment(
        { awb: '1', orderId: 'ORD-1' },
        ctx,
      );

      expect(result.status).toBe('CANCELLED');
      expect(result.courierStatusCode).toBe('CAN');
      expect(result.estimatedDeliveryDate).toBe('2026-09-18');
      expect(result.events.map((e) => e.courierStatusCode)).toEqual(['MAN', 'CAN']);
      expect(result.events[0]).toMatchObject({ status: 'CREATED', location: 'Gurgaon' });
      expect(result.events[1]!.location).toBeUndefined();
    });

    it('keeps a scan with an unknown code — status null, raw code preserved — never guesses', async () => {
      stubAuth();
      nock(BASE)
        .get(PATHS.tracking)
        .query(true)
        .reply(200, {
          status: 'Success',
          data: {
            awbNumber: 1,
            currentStatusCode: 'ZZZ_NEW_CODE',
            scans: [
              { statusDateTime: '03 May 2025, 15:44', statusCode: 'MAN' },
              {
                statusDateTime: '03 May 2025, 15:45',
                statusCode: 'ZZZ_NEW_CODE',
                statusCodeDescription: 'Something new',
              },
            ],
          },
        });
      const result = await factory(courierConfig()).trackShipment(
        { awb: '1', orderId: 'x' },
        testContext().ctx,
      );

      expect(result.status).toBeNull(); // the service will leave the stored status alone
      expect(result.events).toHaveLength(2);
      expect(result.events[1]).toMatchObject({
        status: null,
        courierStatusCode: 'ZZZ_NEW_CODE',
        courierStatusText: 'Something new',
      });
    });

    it('skips only a scan whose timestamp cannot be parsed', async () => {
      stubAuth();
      nock(BASE)
        .get(PATHS.tracking)
        .query(true)
        .reply(200, {
          status: 'Success',
          data: {
            awbNumber: 1,
            currentStatusCode: 'MAN',
            scans: [
              { statusDateTime: '03 May 2025, 15:44', statusCode: 'MAN' },
              { statusDateTime: 'yesterday-ish', statusCode: 'MAN' },
            ],
          },
        });
      const result = await factory(courierConfig()).trackShipment(
        { awb: '1', orderId: 'x' },
        testContext().ctx,
      );
      expect(result.events).toHaveLength(1);
    });
  });

  describe('cancelShipment', () => {
    it('sends the awb and reports cancelled', async () => {
      stubAuth();
      nock(BASE)
        .post(PATHS.cancel, { awbs: '1' })
        .reply(200, { status: 'Success', successResponse: [{ message: 'Cancelled' }] });
      const result = await factory(courierConfig()).cancelShipment(
        { awb: '1', orderId: 'x' },
        testContext().ctx,
      );
      expect(result).toEqual({ cancelled: true, message: 'Cancelled' });
    });
  });
});

describe('status map', () => {
  it('maps the codes confirmed in UAT', () => {
    expect(toShipmentStatus('MAN')).toBe('CREATED');
    expect(toShipmentStatus('CAN')).toBe('CANCELLED');
    expect(toShipmentStatus(' man ')).toBe('CREATED');
  });
  it('returns null for unknown or empty codes', () => {
    expect(toShipmentStatus('NOPE')).toBeNull();
    expect(toShipmentStatus('')).toBeNull();
    expect(toShipmentStatus(undefined)).toBeNull();
  });
});

describe('parseScanDate', () => {
  it('parses UrbaneBolt\'s "DD Mon YYYY, HH:mm" as IST', () => {
    expect(parseScanDate('03 May 2025, 15:47')?.toISOString()).toBe('2025-05-03T10:17:00.000Z');
  });
  it('handles a date without time', () => {
    expect(parseScanDate('02 Oct 2024')?.toISOString()).toBe('2024-10-01T18:30:00.000Z');
  });
  it('falls back to Date parsing for ISO input', () => {
    expect(parseScanDate('2026-09-16T12:00:00Z')?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });
  it('returns null for garbage rather than the epoch', () => {
    expect(parseScanDate('not a date')).toBeNull();
    expect(parseScanDate(undefined)).toBeNull();
  });
});
