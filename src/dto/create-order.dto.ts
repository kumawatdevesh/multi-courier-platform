import { z } from 'zod';

import {
  ADDRESS_TYPES,
  PAYMENT_MODES,
  SERVICE_TYPES,
  type NormalizedOrder,
} from '../couriers/shipment.types';

/** The courier-agnostic wire contract: snake_case here, camelCase internally. */

const addressSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().regex(/^\d{10}$/, 'must be a 10-digit mobile number'),
  email: z.string().email().optional(),
  line1: z.string().min(1).max(250),
  line2: z.string().max(250).optional(),
  city: z.string().min(1).max(80),
  state: z.string().min(1).max(80),
  pincode: z.string().regex(/^\d{6}$/, 'must be a 6-digit pincode'),
  country: z.string().min(1).max(60).default('INDIA'),
  type: z.enum(ADDRESS_TYPES).default('HOME'),
});

const parcelSchema = z.object({
  description: z.string().min(1).max(200),
  weight_kg: z.number().positive().max(100),
  length_cm: z.number().positive().max(500),
  breadth_cm: z.number().positive().max(500),
  height_cm: z.number().positive().max(500),
  pieces: z.number().int().positive().max(100).default(1),
  declared_value: z.number().nonnegative(),
});

const invoiceSchema = z.object({
  number: z.string().min(1).max(60),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)'),
  value: z.number().nonnegative(),
});

export const createOrderSchema = z
  .object({
    order_id: z.string().min(1).max(60),
    courier_partner: z.string().min(1),
    payment_mode: z.enum(PAYMENT_MODES),
    cod_amount: z.number().nonnegative().optional(),
    service_type: z.enum(SERVICE_TYPES).optional(),
    pickup: addressSchema,
    drop: addressSchema,
    return_to: addressSchema.optional(),
    parcel: parcelSchema,
    invoice: invoiceSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.payment_mode === 'COD' && (value.cod_amount ?? 0) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cod_amount'],
        message: 'must be greater than 0 when payment_mode is COD',
      });
    }
    if (value.payment_mode === 'PREPAID' && value.cod_amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cod_amount'],
        message: 'must not be set when payment_mode is PREPAID',
      });
    }
  });

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;

/** Wire → internal. Address and invoice share field names, so only renames are explicit. */
export function toNormalizedOrder(body: CreateOrderRequest): NormalizedOrder {
  return {
    orderId: body.order_id,
    paymentMode: body.payment_mode,
    codAmount: body.cod_amount,
    serviceType: body.service_type,
    pickup: body.pickup,
    drop: body.drop,
    returnTo: body.return_to,
    parcel: {
      description: body.parcel.description,
      weightKg: body.parcel.weight_kg,
      lengthCm: body.parcel.length_cm,
      breadthCm: body.parcel.breadth_cm,
      heightCm: body.parcel.height_cm,
      pieces: body.parcel.pieces,
      declaredValue: body.parcel.declared_value,
    },
    invoice: body.invoice,
    metadata: body.metadata,
  };
}
