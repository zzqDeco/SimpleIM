import type { ApiErrorResponse, ErrorCode } from "@simpleim/contracts";

const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_arguments: 400,
  invalid_credentials: 401,
  username_taken: 409,
  unauthorized: 401,
  csrf_invalid: 403,
  invalid_pop: 401,
  room_full: 409,
  room_limit_exceeded: 429,
  rate_limited: 429,
  invalid_frame: 400,
  payload_too_large: 413,
  not_found: 404,
  internal_error: 500,
  hello_auth_failed: 401,
  cert_expired: 401,
  channel_binding_mismatch: 400,
  chunk_hash_mismatch: 400,
};

export function errorCodeToHttpStatus(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus ?? errorCodeToHttpStatus(code);
  }

  toApiErrorResponse(): ApiErrorResponse {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}
