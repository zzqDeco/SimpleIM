export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatSpeedMBps(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "0.00 MB/s";
  }
  const mbps = bytesPerSec / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

export function formatRoomFingerprint(roomIdOrPrefix: string): string {
  const cleaned = roomIdOrPrefix.trim().replace(/^#/, "").toLowerCase();
  return `#${cleaned.slice(0, 8)}`;
}

export function formatSha256Prefix(sha256Hex: string, length = 12): string {
  return sha256Hex.trim().toLowerCase().slice(0, Math.max(4, length));
}

const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_INLINE_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;

const SAFE_PREVIEW_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/**
 * Extracts the UTC millisecond timestamp encoded in the top 48 bits of an RFC 9562 UUIDv7.
 * Returns null for non-v7 or malformed UUIDs.
 */
export function extractUuidV7TimestampMs(uuid: string): number | null {
  if (!UUID_V7_REGEX.test(uuid)) {
    return null;
  }
  const hex48 = `${uuid.slice(0, 8)}${uuid.slice(9, 13)}`;
  const ms = Number.parseInt(hex48, 16);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export function getFileCreatedAtMs(manifest: {
  readonly fileId: string;
  readonly senderCert?: { readonly payload?: { readonly iat?: number } };
}): number {
  const fromUuid = extractUuidV7TimestampMs(manifest.fileId);
  if (fromUuid !== null) {
    return fromUuid;
  }
  const iat = manifest.senderCert?.payload?.iat;
  if (typeof iat === "number" && Number.isFinite(iat) && iat > 0) {
    return iat;
  }
  return 0;
}

/**
 * Strict raster image allowlist for inline previews (explicitly excludes image/svg+xml).
 */
export function isSafePreviewImage(mimeType: string, fileSize: number): boolean {
  if (
    !Number.isFinite(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_INLINE_IMAGE_PREVIEW_BYTES
  ) {
    return false;
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SAFE_PREVIEW_IMAGE_MIMES.has(normalized);
}

export function formatFileExtensionBadge(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) {
    return "FILE";
  }
  const ext = trimmed
    .slice(dot + 1)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  if (!ext) {
    return "FILE";
  }
  return ext.slice(0, 5);
}

export interface RelativeDateLabels {
  readonly today: string;
  readonly yesterday: string;
}

function toLocalCalendarDayNumber(d: Date): number {
  return Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000,
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function getLocalDayKey(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "";
  }
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatMessageTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "--:--";
  }
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatMessageClockShort(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "--:--";
  }
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatMessageDateTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "--:--";
  }
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDatePillLabel(
  epochMs: number,
  nowMs: number,
  labels: RelativeDateLabels,
): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "";
  }
  const d = new Date(epochMs);
  const now = new Date(nowMs);
  const diffDays =
    toLocalCalendarDayNumber(now) - toLocalCalendarDayNumber(d);
  const mmdd = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (diffDays === 0) {
    return `${labels.today} · ${mmdd}`;
  }
  if (diffDays === 1) {
    return `${labels.yesterday} · ${mmdd}`;
  }
  return `${d.getFullYear()}-${mmdd}`;
}

export function formatTranscriptDividerLabel(
  epochMs: number,
  nowMs: number,
  labels: RelativeDateLabels,
  isDayBoundary: boolean,
): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "--:--";
  }
  const d = new Date(epochMs);
  const now = new Date(nowMs);
  const diffDays =
    toLocalCalendarDayNumber(now) - toLocalCalendarDayNumber(d);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  if (diffDays === 0) {
    return isDayBoundary ? `${labels.today} ${hhmm}` : hhmm;
  }
  if (diffDays === 1) {
    return `${labels.yesterday} ${hhmm}`;
  }
  const mmdd = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${mmdd} ${hhmm}`;
  }
  return `${d.getFullYear()}-${mmdd} ${hhmm}`;
}

export function msUntilNextLocalMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    50,
  );
  return Math.max(1_000, nextMidnight.getTime() - nowMs);
}

export function formatRoomActivityTime(
  epochMs: number,
  nowMs: number,
  labels: RelativeDateLabels,
): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "";
  }
  const d = new Date(epochMs);
  const now = new Date(nowMs);
  const diffDays =
    toLocalCalendarDayNumber(now) - toLocalCalendarDayNumber(d);
  if (diffDays === 0) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (diffDays === 1) {
    return labels.yesterday;
  }
  const mmdd = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return mmdd;
  }
  return `${d.getFullYear()}-${mmdd}`;
}
