import { AppError, type AppErrorOptions } from './app-error';
import { ERROR_MESSAGES, type ErrorCode } from './error-codes';

export interface CourierErrorOptions extends AppErrorOptions {
  courierPartner: string;
  /** Persisted and logged, never returned to the client. */
  rawResponse?: unknown;
  courierCode?: string | undefined;
  /** Defaults to ERROR_MESSAGES[code]. */
  message?: string | undefined;
}

/** Keeps the vendor's raw payload attached for audit without letting it reach the client. */
export class CourierError extends AppError {
  readonly courierPartner: string;
  readonly rawResponse: unknown;
  readonly courierCode?: string | undefined;

  constructor(code: ErrorCode, opts: CourierErrorOptions) {
    super(code, opts.message ?? ERROR_MESSAGES[code], opts);
    this.courierPartner = opts.courierPartner;
    this.rawResponse = opts.rawResponse;
    this.courierCode = opts.courierCode;
  }

  toPersisted(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      courierPartner: this.courierPartner,
      courierCode: this.courierCode,
      rawResponse: this.rawResponse,
      at: new Date().toISOString(),
    };
  }
}
