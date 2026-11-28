import { homedir } from "node:os";
import {
  clearScreenDown,
  createInterface,
  cursorTo,
  moveCursor,
  type Interface as ReadlineInterface,
} from "node:readline";
import type { FileManifest } from "@simpleim/contracts";
import { sanitizeTerminalSingleLine } from "./terminal-sanitize.ts";

export interface TtyCapableStream {
  isTTY?: boolean;
  columns?: number;
}

export function isTtyStream(stream: unknown): boolean {
  return Boolean(
    stream &&
      typeof stream === "object" &&
      (stream as TtyCapableStream).isTTY === true,
  );
}

/**
 * Honors https://no-color.org/ (any non-empty NO_COLOR disables ANSI styling),
 * TERM=dumb, and non-TTY streams.
 */
export function shouldUseColor(
  stream: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isTtyStream(stream)) {
    return false;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return true;
}

export interface CliPalette {
  readonly enabled: boolean;
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
}

export function createCliPalette(enabled: boolean): CliPalette {
  const wrap = (code: string) => (text: string) =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    enabled,
    dim: wrap("2"),
    cyan: wrap("36"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
  };
}

/**
 * Formats an opaque UUIDv7-based ID compactly for 80-column display using its
 * random tail (UUIDv7 places the 48-bit timestamp prefix at the front, so the
 * trailing random hex characters avoid collisions within 65s timestamp buckets).
 */
export function formatShortId(id: string, tailChars = 8): string {
  const safe = sanitizeTerminalSingleLine(id);
  const underscoreIdx = safe.indexOf("_");
  if (underscoreIdx > 0 && underscoreIdx <= 8) {
    const prefix = safe.slice(0, underscoreIdx + 1);
    const body = safe.slice(underscoreIdx + 1);
    return body.length > tailChars ? `${prefix}${body.slice(-tailChars)}` : safe;
  }
  return safe.length > tailChars ? safe.slice(-tailChars) : safe;
}

/**
 * Returns the shortest unambiguous suffix (>= minLen) for `fileId` across all
 * known room file IDs (falling back to the full ID if needed). Because UUIDv7
 * encodes randomness at the end, the random tail stays unambiguous even for
 * files announced within the same millisecond or 65-second timestamp bucket.
 */
export function formatUniqueFileSelector(
  fileId: string,
  allFileIds: readonly string[],
  minLen = 8,
): string {
  const safe = sanitizeTerminalSingleLine(fileId);
  if (safe.length <= minLen) {
    return safe;
  }
  const normalizedOthers = allFileIds
    .map((id) => sanitizeTerminalSingleLine(id))
    .filter((id) => id !== safe);

  for (let len = minLen; len < safe.length; len++) {
    const candidate = safe.slice(-len);
    if (candidate.startsWith("-")) {
      continue;
    }
    const collides = normalizedOthers.some(
      (other) =>
        other === candidate ||
        other.startsWith(candidate) ||
        other.endsWith(candidate),
    );
    if (!collides) {
      return candidate;
    }
  }
  return safe;
}

/**
 * Formats a room fingerprint consistently with Web (`#a1b2c3d4`).
 */
export function formatCliRoomFingerprint(roomIdPrefix: string): string {
  const clean = sanitizeTerminalSingleLine(roomIdPrefix)
    .toLowerCase()
    .replace(/^#/, "");
  return `#${clean.slice(0, 8)}`;
}

/**
 * Formats a timestamp for CLI chat output:
 * - Same local calendar day -> `HH:MM:SS`
 * - Earlier/different day (e.g. `[sync]` history) -> `YYYY-MM-DD HH:MM:SS`
 */
export function formatCliTimestamp(
  epochMs: number,
  nowMs: number = Date.now(),
): string {
  const d = new Date(epochMs);
  const now = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${hh}:${mm}:${ss}`;
  }
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}`;
}

const WINDOWS_DRIVE_OR_UNC_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/**
 * Parses a user-entered file path for `/send`:
 * - Strips matching outer single or double quotes (e.g. `'/Users/x/My File.pdf'`, `"C:\Users\x\My File.pdf"`)
 * - On POSIX paths, unescapes shell backslash-escaped spaces/metacharacters from Finder drag-and-drop (`My\ File\ \(1\).pdf`)
 * - Preserves native Windows drive (`C:\...`) and UNC (`\\server\share\...`) separators intact
 * - Expands leading `~` / `~/` (and `~\` on Windows) to the user's home directory
 */
export function parseCliFilePathInput(
  rawInput: string,
  homeDirectory: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return "";
  }

  let parsed = "";
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if (trimmed.length >= 2 && first === "'" && last === "'") {
    parsed = trimmed.slice(1, -1);
  } else if (trimmed.length >= 2 && first === '"' && last === '"') {
    const inner = trimmed.slice(1, -1);
    if (platform === "win32" || WINDOWS_DRIVE_OR_UNC_RE.test(inner)) {
      parsed = inner.replace(/\\"/g, '"');
    } else {
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if (ch === "\\" && i + 1 < inner.length) {
          const next = inner[i + 1]!;
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            parsed += next;
            i++;
            continue;
          }
        }
        parsed += ch;
      }
    }
  } else if (platform === "win32" || WINDOWS_DRIVE_OR_UNC_RE.test(trimmed)) {
    parsed = trimmed;
  } else {
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (ch === "\\" && i + 1 < trimmed.length) {
        parsed += trimmed[i + 1]!;
        i++;
        continue;
      }
      parsed += ch;
    }
  }

  if (parsed === "~") {
    return homeDirectory;
  }
  if (
    parsed.startsWith("~/") ||
    (platform === "win32" && parsed.startsWith("~\\"))
  ) {
    return `${homeDirectory}${parsed.slice(1)}`;
  }
  return parsed;
}

/**
 * Translates raw Node/Bun filesystem errno exceptions into user-friendly messages.
 */
export function formatCliFsError(err: unknown, targetPath: string): string {
  const safePath = sanitizeTerminalSingleLine(targetPath);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  switch (code) {
    case "ENOENT":
      return `File not found: ${safePath}`;
    case "EACCES":
    case "EPERM":
      return `Permission denied: ${safePath}`;
    case "EISDIR":
      return `Expected a file, but path is a directory: ${safePath}`;
    case "ENOTDIR":
      return `Invalid directory component in path: ${safePath}`;
    default:
      return sanitizeTerminalSingleLine(
        err instanceof Error ? err.message : String(err),
      );
  }
}

export function formatEtaSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--";
  }
  const rounded = Math.ceil(seconds);
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  if (mins < 60) {
    return `${mins}m${String(secs).padStart(2, "0")}s`;
  }
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${String(remMins).padStart(2, "0")}m`;
}

export const JOIN_SLASH_COMMANDS = [
  "/peers",
  "/send ",
  "/files",
  "/get ",
  "/cancel ",
  "/reply ",
  "/retry",
  "/help",
  "/leave",
  "/quit",
] as const;

export function createJoinCompleter(
  getFiles: () => readonly FileManifest[],
): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const trimmedLeft = line.trimStart();
    if (!trimmedLeft.startsWith("/")) {
      return [[], line];
    }

    const fileCmdMatch = /^(\/(?:get|cancel)\s+)(.*)$/i.exec(trimmedLeft);
    if (fileCmdMatch) {
      const prefix = fileCmdMatch[1]!;
      const partial = fileCmdMatch[2] ?? "";
      const files = getFiles();
      const allIds = files.map((f) => f.fileId);
      const candidates: string[] = [];
      files.forEach((f, idx) => {
        candidates.push(String(idx + 1));
        candidates.push(formatUniqueFileSelector(f.fileId, allIds, 8));
        candidates.push(f.fileId);
      });
      const unique = Array.from(new Set(candidates));
      const matches = unique
        .filter((c) => c.startsWith(partial))
        .map((c) => `${prefix}${c}`);
      return [matches, trimmedLeft];
    }

    if (!trimmedLeft.includes(" ")) {
      const hits = JOIN_SLASH_COMMANDS.filter((cmd) =>
        cmd.startsWith(trimmedLeft.toLowerCase()),
      );
      return [hits.length > 0 ? [...hits] : [...JOIN_SLASH_COMMANDS], trimmedLeft];
    }

    return [[], line];
  };
}

function estimateVisualColumns(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Count CJK / fullwidth / emoji conservatively as 2 terminal cells
    width += cp > 0x7f ? 2 : 1;
  }
  return width;
}

export interface InteractiveJoinTerminalOptions {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly jsonMode?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly getFiles?: () => readonly FileManifest[];
  readonly onLine: (line: string) => Promise<"continue" | "exit">;
  readonly onLineError?: (err: unknown) => void;
  readonly onExit?: () => void;
  readonly onInputEof?: () => void;
}

type InternalReadline = ReadlineInterface & {
  _refreshLine?: () => void;
  prevRows?: number;
};

/**
 * Coordinates readline interactive input with asynchronous incoming room output
 * so live P2P messages never corrupt the user's active prompt/input line on a TTY.
 */
export class InteractiveJoinTerminal {
  readonly isInteractive: boolean;
  readonly palette: CliPalette;
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly rl: InternalReadline;
  private readonly promptVisualWidth = 2; // "❯ "
  private readonly onStdinData?: () => void;
  private inputClosed = false;
  private exited = false;
  private promptDrawn = false;
  private typeAheadVisibleOnScreen = false;
  private outputEpoch = 0;
  private activeLineEpoch: number | null = null;
  private lineQueue: Promise<void> = Promise.resolve();

  constructor(options: InteractiveJoinTerminalOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.isInteractive =
      !options.jsonMode &&
      isTtyStream(options.stdin) &&
      isTtyStream(options.stdout);
    this.palette = createCliPalette(
      !options.jsonMode && shouldUseColor(options.stdout, options.env),
    );

    if ("resume" in options.stdin && typeof options.stdin.resume === "function") {
      options.stdin.resume();
    }

    const promptText = this.isInteractive
      ? `${this.palette.cyan("❯")} `
      : "";

    this.rl = createInterface({
      input: options.stdin,
      ...(this.isInteractive ? { output: options.stdout } : {}),
      terminal: this.isInteractive,
      ...(this.isInteractive ? { prompt: promptText } : {}),
      ...(this.isInteractive && options.getFiles
        ? { completer: createJoinCompleter(options.getFiles) }
        : {}),
    }) as InternalReadline;

    if (this.isInteractive) {
      this.onStdinData = () => {
        if (this.rl.line.length > 0) {
          this.typeAheadVisibleOnScreen = true;
        }
      };
      this.stdin.on("data", this.onStdinData);
    }

    this.rl.on("SIGINT", () => {
      if (this.exited) return;
      this.exited = true;
      this.close();
      options.onExit?.();
    });

    this.rl.on("line", (rawLine) => {
      this.promptDrawn = false;
      this.typeAheadVisibleOnScreen = false;
      const submittedEpoch = ++this.outputEpoch;
      this.lineQueue = this.lineQueue
        .then(async () => {
          if (this.exited) return;
          this.activeLineEpoch = submittedEpoch;
          try {
            const action = await options.onLine(rawLine);
            if (action === "exit") {
              this.exited = true;
              this.close();
              options.onExit?.();
              return;
            }
          } catch (err) {
            options.onLineError?.(err);
          } finally {
            this.activeLineEpoch = null;
            this.outputEpoch += 1;
          }
          if (!this.exited && !this.inputClosed && this.isInteractive) {
            if (this.typeAheadVisibleOnScreen && this.rl.line.length > 0) {
              this.clearActiveInputRegion(this.promptDrawn);
            }
            this.redrawPromptPreservingCursor();
          }
        })
        .catch(() => {});
    });

    this.rl.on("close", () => {
      this.inputClosed = true;
      if (this.onStdinData) {
        this.stdin.removeListener("data", this.onStdinData);
      }
      // Drain all already-accepted queued lines before signaling EOF so piped
      // commands (e.g. `one\ntwo\n/quit\n`) are never discarded on immediate EOF.
      void this.lineQueue.then(() => {
        if (!this.exited) {
          options.onInputEof?.();
        }
      });
    });
  }

  startPrompt(): void {
    if (!this.exited && !this.inputClosed && this.isInteractive) {
      this.rl.prompt();
      this.promptDrawn = true;
    }
  }

  /**
   * Erases the single-row TTY echo of the line just submitted by the user so
   * formatted self-messages are not displayed twice — ONLY when no subsequent
   * pasted lines or asynchronous output have advanced the terminal below it.
   */
  eraseJustSubmittedSingleLineEcho(rawLine: string): void {
    if (
      !this.isInteractive ||
      this.exited ||
      this.inputClosed ||
      this.activeLineEpoch === null ||
      this.activeLineEpoch !== this.outputEpoch
    ) {
      return;
    }
    const cols = Math.max(
      20,
      (this.stdout as TtyCapableStream).columns ?? 80,
    );
    if (this.promptVisualWidth + estimateVisualColumns(rawLine) < cols) {
      this.outputEpoch += 1;
      this.stdout.write("\x1b[1A\r\x1b[2K");
    }
  }

  private clearActiveInputRegion(includePromptWidth: boolean): void {
    const cols = Math.max(
      1,
      (this.stdout as TtyCapableStream).columns ?? 80,
    );
    let cursorRow: number;
    if (includePromptWidth && typeof this.rl.getCursorPos === "function") {
      cursorRow = this.rl.getCursorPos().rows;
    } else {
      const prefixWidth = includePromptWidth ? this.promptVisualWidth : 0;
      const beforeCursor = this.rl.line.slice(0, this.rl.cursor);
      cursorRow = Math.floor(
        (prefixWidth + estimateVisualColumns(beforeCursor)) / cols,
      );
    }
    const rowsUp = Math.max(cursorRow, this.rl.prevRows ?? 0);
    if (rowsUp > 0) {
      moveCursor(this.stdout, 0, -rowsUp);
    }
    cursorTo(this.stdout, 0);
    clearScreenDown(this.stdout);
    this.rl.prevRows = 0;
    this.promptDrawn = false;
    this.typeAheadVisibleOnScreen = false;
  }

  private redrawPromptPreservingCursor(): void {
    this.rl.prevRows = 0;
    if (typeof this.rl._refreshLine === "function") {
      this.rl._refreshLine();
    } else {
      this.rl.prompt(true);
    }
    this.promptDrawn = true;
    this.typeAheadVisibleOnScreen = this.rl.line.length > 0;
  }

  /**
   * Safely prints an asynchronous line (incoming message, peer join, file event)
   * without corrupting single- or multi-row wrapped input at the TTY prompt.
   */
  writeAsyncLine(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.outputEpoch += 1;
    const target = stream === "stderr" ? this.stderr : this.stdout;
    if (this.isInteractive && !this.exited && !this.inputClosed) {
      this.clearActiveInputRegion(this.promptDrawn);
      target.write(`${text}\n`);
      this.redrawPromptPreservingCursor();
      return;
    }
    target.write(`${text}\n`);
  }

  /**
   * Prints synchronous output produced while handling the user's submitted line
   * (prompt will be re-displayed once the line handler resolves).
   */
  writeLine(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.outputEpoch += 1;
    const target = stream === "stderr" ? this.stderr : this.stdout;
    if (
      this.isInteractive &&
      !this.exited &&
      !this.inputClosed &&
      this.typeAheadVisibleOnScreen &&
      this.rl.line.length > 0
    ) {
      this.clearActiveInputRegion(this.promptDrawn);
    }
    target.write(`${text}\n`);
  }

  close(): void {
    this.exited = true;
    if (this.onStdinData) {
      this.stdin.removeListener("data", this.onStdinData);
    }
    if (this.inputClosed) return;
    this.inputClosed = true;
    if (this.isInteractive) {
      this.clearActiveInputRegion(this.promptDrawn);
    }
    this.rl.close();
  }
}
