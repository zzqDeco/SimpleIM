import {
  ContractValidationError,
  ERROR_CODES,
  type ErrorCode,
} from "@simpleim/contracts";
import { HttpApiError } from "../api/http-client.ts";
import type { TranslateFn, TranslationKey } from "./types.ts";

export type ValidationErrorKey =
  | "validation.username"
  | "validation.passwordRequired"
  | "validation.passwordLength"
  | "validation.displayNameLength"
  | "validation.passphraseLength";

export type AppFailure =
  | { readonly kind: "api"; readonly code: ErrorCode }
  | { readonly kind: "validation"; readonly key: ValidationErrorKey }
  | { readonly kind: "network" }
  | { readonly kind: "room_inactive" }
  | { readonly kind: "runtime"; readonly detail: string };

const ERROR_CODE_TO_KEY: Readonly<Record<ErrorCode, TranslationKey>> = {
  invalid_arguments: "error.invalid_arguments",
  invalid_credentials: "error.invalid_credentials",
  username_taken: "error.username_taken",
  unauthorized: "error.unauthorized",
  csrf_invalid: "error.csrf_invalid",
  invalid_pop: "error.invalid_pop",
  room_full: "error.room_full",
  room_limit_exceeded: "error.room_limit_exceeded",
  rate_limited: "error.rate_limited",
  invalid_frame: "error.invalid_frame",
  payload_too_large: "error.payload_too_large",
  not_found: "error.not_found",
  internal_error: "error.internal_error",
  hello_auth_failed: "error.hello_auth_failed",
  cert_expired: "error.cert_expired",
  channel_binding_mismatch: "error.channel_binding_mismatch",
  chunk_hash_mismatch: "error.chunk_hash_mismatch",
};

const SIGNALING_ERROR_PREFIX_RE = /^Signaling error \[([a-z0-9_]+)\]:/i;
const INACTIVE_ROOM_RE = /\b(?:not active|is stopped)\b/i;
const NETWORK_TRANSPORT_RE =
  /(?:failed to fetch|networkerror|load failed|signaling websocket|websocket closed)/i;

function isKnownErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

export function errorCodeTranslationKey(code: ErrorCode): TranslationKey {
  return ERROR_CODE_TO_KEY[code];
}

export function toAppFailure(err: unknown): AppFailure {
  if (err instanceof HttpApiError) {
    return {
      kind: "api",
      code: isKnownErrorCode(err.code) ? err.code : "internal_error",
    };
  }
  if (err instanceof ContractValidationError) {
    return {
      kind: "api",
      code: isKnownErrorCode(err.code) ? err.code : "invalid_arguments",
    };
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    isKnownErrorCode((err as { code: unknown }).code)
  ) {
    return {
      kind: "api",
      code: (err as { code: ErrorCode }).code,
    };
  }

  if (err instanceof TypeError) {
    return { kind: "network" };
  }

  if (err instanceof Error) {
    const sigMatch = SIGNALING_ERROR_PREFIX_RE.exec(err.message);
    if (sigMatch) {
      const parsedCode = sigMatch[1]?.toLowerCase();
      return {
        kind: "api",
        code: isKnownErrorCode(parsedCode) ? parsedCode : "internal_error",
      };
    }

    if (INACTIVE_ROOM_RE.test(err.message)) {
      return { kind: "room_inactive" };
    }

    if (NETWORK_TRANSPORT_RE.test(err.message)) {
      return { kind: "network" };
    }

    const trimmed = err.message.trim();
    if (trimmed.length > 0) {
      return { kind: "runtime", detail: trimmed };
    }
  }

  return { kind: "api", code: "internal_error" };
}

export function formatAppFailure(failure: AppFailure, t: TranslateFn): string {
  switch (failure.kind) {
    case "validation":
      return t(failure.key);
    case "api":
      return t(ERROR_CODE_TO_KEY[failure.code]);
    case "room_inactive":
      return t("error.room_inactive");
    case "network":
      return t("error.network");
    case "runtime":
      return failure.detail;
  }
}
