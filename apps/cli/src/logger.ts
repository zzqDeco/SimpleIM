import { generateUuidV7 } from "@simpleim/crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BoundaryLogEntry {
  event: string;
  level?: LogLevel;
  correlationId?: string;
  roomIdPrefix?: string;
  durationMs?: number;
  errorCode?: string;
  meta?: Record<string, unknown>;
}

const FORBIDDEN_META_KEYS = new Set([
  "password",
  "passphrase",
  "roompassphrase",
  "sessiontoken",
  "token",
  "authorization",
  "csrftoken",
  "masterseed",
  "signalingkey",
  "roomauthkey",
  "roomappkey",
  "sdp",
  "offersdp",
  "answersdp",
  "candidate",
  "icecandidate",
  "body",
  "messagebody",
  "chatbody",
  "filename",
  "rawname",
  "filepath",
  "filebytes",
  "payload",
  "ciphertext",
  "privatekey",
  "peersignprivkey",
  "serversignprivkey",
]);

function sanitizeMeta(
  raw: Record<string, unknown>,
): { sanitized: Record<string, unknown>; extractedRoomPrefix?: string } {
  const sanitized: Record<string, unknown> = {};
  let extractedRoomPrefix: string | undefined;

  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (lower === "roomid") {
      if (typeof value === "string" && value.length >= 8) {
        extractedRoomPrefix = value.slice(0, 8).toLowerCase();
      }
      continue;
    }
    if (FORBIDDEN_META_KEYS.has(lower)) {
      continue;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      continue;
    }
    if (typeof value === "number") {
      sanitized[key] = Number.isFinite(value) ? value : null;
    } else if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === null
    ) {
      sanitized[key] = value;
    }
  }

  return { sanitized, extractedRoomPrefix };
}

export function normalizeRoomIdPrefix(roomIdOrPrefix?: string): string | undefined {
  if (!roomIdOrPrefix) return undefined;
  const trimmed = roomIdOrPrefix.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 8);
}

export class StructuredLogger {
  private readonly sink: (line: string) => void;
  private readonly defaultCorrelationId: string;

  constructor(options?: {
    sink?: (line: string) => void;
    correlationId?: string;
  }) {
    this.sink =
      options?.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
    this.defaultCorrelationId = options?.correlationId ?? generateUuidV7();
  }

  get correlationId(): string {
    return this.defaultCorrelationId;
  }

  log(entry: BoundaryLogEntry): void {
    const level: LogLevel = entry.level ?? "info";
    const correlationId = entry.correlationId ?? this.defaultCorrelationId;
    const { sanitized, extractedRoomPrefix } = entry.meta
      ? sanitizeMeta(entry.meta)
      : { sanitized: {}, extractedRoomPrefix: undefined };

    const roomIdPrefix = normalizeRoomIdPrefix(
      entry.roomIdPrefix ?? extractedRoomPrefix,
    );

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: "simpleim-cli",
      correlationId,
      event: entry.event,
    };

    if (roomIdPrefix !== undefined) {
      record.roomIdPrefix = roomIdPrefix;
    }
    if (entry.durationMs !== undefined && Number.isFinite(entry.durationMs)) {
      record.durationMs = Math.max(0, Math.round(entry.durationMs));
    }
    if (entry.errorCode !== undefined) {
      record.errorCode = entry.errorCode;
    }
    for (const [k, v] of Object.entries(sanitized)) {
      if (!(k in record)) {
        record[k] = v;
      }
    }

    this.sink(JSON.stringify(record));
  }

  info(event: string, fields?: Omit<BoundaryLogEntry, "event" | "level">): void {
    this.log({ ...fields, event, level: "info" });
  }

  warn(event: string, fields?: Omit<BoundaryLogEntry, "event" | "level">): void {
    this.log({ ...fields, event, level: "warn" });
  }

  error(event: string, fields?: Omit<BoundaryLogEntry, "event" | "level">): void {
    this.log({ ...fields, event, level: "error" });
  }
}
