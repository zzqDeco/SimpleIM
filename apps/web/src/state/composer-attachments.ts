const MIME_EXTENSION_MAP: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Generates a deterministic local-time filename for unnamed clipboard pastes
 * (e.g. macOS/iOS screenshots that arrive as empty or generic "image.png").
 */
export function makeClipboardFileName(
  mimeType: string,
  nowMs: number,
  sequenceIndex = 0,
): string {
  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = MIME_EXTENSION_MAP[normalizedMime] ?? "bin";
  const d = new Date(nowMs);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const suffix = sequenceIndex > 0 ? `-${sequenceIndex + 1}` : "";
  const prefix = normalizedMime.startsWith("image/") ? "image" : "clipboard";
  return `${prefix}-${stamp}${suffix}.${ext}`;
}

export function shouldRenameClipboardFile(fileName: string): boolean {
  const trimmed = fileName.trim().toLowerCase();
  return (
    trimmed.length === 0 ||
    trimmed === "image.png" ||
    trimmed === "image.jpg" ||
    trimmed === "image.jpeg" ||
    trimmed === "blob"
  );
}

export interface ClipboardItemLike {
  readonly kind: string;
  getAsFile(): File | null;
}

export interface ClipboardDataLike {
  readonly items?: ArrayLike<ClipboardItemLike> | null;
  readonly files?: ArrayLike<File> | null;
}

/**
 * Extracts pasted files from a paste event's DataTransfer/clipboardData,
 * renaming unnamed or generic screenshot names cleanly.
 */
export function extractFilesFromClipboard(
  clipboardData: ClipboardDataLike | null | undefined,
  nowMs: number = Date.now(),
): File[] {
  if (!clipboardData) {
    return [];
  }
  const rawFiles: File[] = [];
  if (clipboardData.items && clipboardData.items.length > 0) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item && item.kind === "file") {
        const f = item.getAsFile();
        if (f) {
          rawFiles.push(f);
        }
      }
    }
  } else if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const f = clipboardData.files[i];
      if (f) {
        rawFiles.push(f);
      }
    }
  }

  return rawFiles.map((file, idx) => {
    if (shouldRenameClipboardFile(file.name)) {
      const nextName = makeClipboardFileName(file.type, nowMs, idx);
      return new File([file], nextName, {
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified || nowMs,
      });
    }
    return file;
  });
}
