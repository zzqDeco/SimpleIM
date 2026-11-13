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

export function formatMessageTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "--:--";
  }
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
