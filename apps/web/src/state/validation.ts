import { isValidPassword, isValidUsername } from "@simpleim/contracts";
import type { ValidationErrorKey } from "../i18n/error-catalog.ts";

export type AuthMode = "login" | "register";

export interface AuthValidationInput {
  readonly mode: AuthMode;
  readonly username: string;
  readonly password: string;
  readonly displayName: string;
}

export function validateAuthInput(
  input: AuthValidationInput,
): ValidationErrorKey | null {
  const normalizedUsername = input.username.trim().toLowerCase();
  if (!isValidUsername(normalizedUsername)) {
    return "validation.username";
  }

  if (input.mode === "register") {
    if (!isValidPassword(input.password)) {
      return "validation.passwordLength";
    }
    if (input.displayName.trim().length > 32) {
      return "validation.displayNameLength";
    }
    return null;
  }

  if (input.password.length === 0) {
    return "validation.passwordRequired";
  }
  return null;
}

export function validateRoomPassphrase(
  rawPassphrase: string,
): ValidationErrorKey | null {
  const normalized = rawPassphrase.normalize("NFC");
  const byteLen = new TextEncoder().encode(normalized).byteLength;
  if (byteLen < 1 || byteLen > 256) {
    return "validation.passphraseLength";
  }
  return null;
}
