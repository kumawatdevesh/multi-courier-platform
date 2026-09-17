import { ERROR_CODES, RETRYABLE_CODES, type ErrorCode, type FieldError } from './error-codes';

export interface AppErrorOptions {
  details?: FieldError[] | undefined;
  context?: Record<string, unknown> | undefined;
  cause?: unknown;
  /** Overrides the RETRYABLE_CODES default. */
  retryable?: boolean | undefined;
  /** For DUPLICATE_ORDER: where the existing shipment is. Serialized to the client. */
  existing?: { id: string; status: string; awb: string | null } | undefined;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: FieldError[] | undefined;
  /** Logged, never serialized to the client. */
  readonly context?: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly existing?: AppErrorOptions['existing'];

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = ERROR_CODES[code];
    this.details = opts.details;
    this.context = opts.context;
    this.retryable = opts.retryable ?? RETRYABLE_CODES.has(code);
    this.existing = opts.existing;
    Error.captureStackTrace?.(this, new.target);
  }
}
