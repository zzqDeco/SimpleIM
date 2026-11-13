export const ERROR_CODES = [
  "invalid_arguments",
  "invalid_credentials",
  "username_taken",
  "unauthorized",
  "csrf_invalid",
  "invalid_pop",
  "room_full",
  "room_limit_exceeded",
  "rate_limited",
  "invalid_frame",
  "payload_too_large",
  "not_found",
  "internal_error",
  "hello_auth_failed",
  "cert_expired",
  "channel_binding_mismatch",
  "chunk_hash_mismatch",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorDetail {
  code: ErrorCode;
  message: string;
}

export interface ApiErrorResponse {
  ok: false;
  error: ApiErrorDetail;
}

export type ApiResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | ApiErrorResponse;

export class ContractValidationError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = "invalid_arguments") {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
  }
}
