import { CourierError } from '../../errors/courier-error';
import type { ErrorCode } from '../../errors/error-codes';
import type { CourierConfig, CourierContext } from '../courier.interface';
import { CourierHttpClient } from '../shared/http-client';
import { createTokenCache } from './urbanebolt.auth';

export const PATHS = {
  manifest: '/api/v1/services/manifest/',
  tracking: '/api/v1/services/tracking-pub/',
  cancel: '/api/v1/services/cancel/',
} as const;

interface UbEnvelope {
  status?: string;
  message?: string;
}

export interface UbManifestSuccess {
  status: string;
  orderNumber: string;
  awbNumber: number | string;
  routeCode?: string;
  shippingLabel?: string;
  customerCode?: string;
}

export interface UbManifestFailure {
  orderNumber?: string;
  customerCode?: string;
  status?: string;
  message?: string;
}

interface UbManifestResponse extends UbEnvelope {
  successResponse?: UbManifestSuccess[];
  errorResponse?: UbManifestFailure[];
}

export interface UbScan {
  statusDateTime?: string;
  statusCode?: string;
  statusCodeDescription?: string;
  reasonCode?: string;
  reasonCodeDescription?: string;
  currentLocation?: string;
}

export interface UbTrackingData {
  awbNumber?: number | string;
  orderNumber?: string;
  origin?: string;
  destination?: string;
  currentLocation?: string;
  edd?: string;
  currentStatusDateTime?: string;
  currentStatusCode?: string;
  currentStatusCodeDescription?: string;
  scans?: UbScan[];
}

interface UbTrackingResponse extends UbEnvelope {
  data?: UbTrackingData | unknown[];
}

interface UbCancelResponse extends UbEnvelope {
  successResponse?: Array<{ orderNumber?: string; awb?: string; message?: string }>;
  failureResponse?: Array<{ awb?: string; message?: string }>;
}

export class UrbaneBoltClient {
  private readonly http: CourierHttpClient;

  constructor(private readonly config: CourierConfig) {
    this.http = new CourierHttpClient(config, createTokenCache(config));
  }

  private reject(code: ErrorCode, body: unknown, courierCode?: string): never {
    throw new CourierError(code, {
      courierPartner: this.config.key,
      rawResponse: body,
      courierCode,
    });
  }

  /** Failures arrive as HTTP 200 + status:"Failed" — never trust the status code alone. */
  private assertEnvelopeOk<T extends UbEnvelope>(body: T): T {
    if ((body?.status ?? '').toLowerCase() === 'failed') {
      this.reject('COURIER_REJECTED', body, body.status);
    }
    return body;
  }

  async manifest(
    payload: Record<string, unknown>,
    ctx: CourierContext,
  ): Promise<UbManifestSuccess> {
    const { data } = await this.http.request<UbManifestResponse>(
      { method: 'POST', path: PATHS.manifest, body: [payload] },
      ctx,
    );
    this.assertEnvelopeOk(data);

    const created = data.successResponse?.[0];
    if (created) return created;

    // Success envelope with the order in errorResponse[]; no structured duplicate code exists.
    const rejected = data.errorResponse?.[0];
    const duplicate = /already\s*(shipped|exists|manifested)/i.test(rejected?.message ?? '');
    return this.reject(duplicate ? 'DUPLICATE_ORDER' : 'COURIER_REJECTED', data, rejected?.status);
  }

  async track(awb: string, ctx: CourierContext): Promise<UbTrackingData> {
    const { data } = await this.http.request<UbTrackingResponse>(
      { method: 'GET', path: PATHS.tracking, query: { awb } },
      ctx,
    );
    this.assertEnvelopeOk(data);

    if (!data.data || Array.isArray(data.data)) {
      this.reject('ORDER_NOT_FOUND', data);
    }
    return data.data;
  }

  async cancel(awb: string, ctx: CourierContext): Promise<{ message?: string | undefined }> {
    const { data } = await this.http.request<UbCancelResponse>(
      { method: 'POST', path: PATHS.cancel, body: { awbs: awb } },
      ctx,
    );
    this.assertEnvelopeOk(data);

    if (data.failureResponse?.[0]) {
      this.reject('COURIER_REJECTED', data);
    }
    return { message: data.successResponse?.[0]?.message ?? data.message };
  }
}
