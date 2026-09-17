export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNKNOWN_COURIER: 400,
  DUPLICATE_ORDER: 409,
  INVALID_ORDER_STATE: 409,
  ORDER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  COURIER_AUTH_FAILED: 502,
  COURIER_REJECTED: 422,
  COURIER_UNAVAILABLE: 503,
  COURIER_TIMEOUT: 504,
  DISPATCH_INTERRUPTED: 500,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Default client-facing wording per code; courier-side throws never use vendor text. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Request validation failed',
  UNKNOWN_COURIER: 'Unsupported courier partner',
  DUPLICATE_ORDER: 'A shipment already exists for this order reference',
  INVALID_ORDER_STATE: 'The order is not in a state that allows this operation',
  ORDER_NOT_FOUND: 'Order not found',
  NOT_FOUND: 'Not found',
  COURIER_AUTH_FAILED: 'Courier authentication failed',
  COURIER_REJECTED: 'Courier rejected the request',
  COURIER_UNAVAILABLE: 'Courier is unavailable',
  COURIER_TIMEOUT: 'Courier did not respond in time',
  DISPATCH_INTERRUPTED: 'Dispatch did not complete; confirm with the courier before resubmitting',
  PAYLOAD_TOO_LARGE: 'Request body is too large',
  RATE_LIMITED: 'Courier rate limit exceeded',
  INTERNAL_ERROR: 'An unexpected error occurred',
};

export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'COURIER_UNAVAILABLE',
  'COURIER_TIMEOUT',
  'RATE_LIMITED',
]);

export interface FieldError {
  field: string;
  message: string;
  rejectedValue?: unknown;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: FieldError[] | undefined;
    /** DUPLICATE_ORDER only: the order that already holds this order_id. */
    existing?: { id: string; status: string; awb: string | null } | undefined;
    requestId: string;
    timestamp: string;
  };
}
