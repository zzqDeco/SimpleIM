/**
 * Strips ANSI/VT escape sequences, C0/C1 control characters, and Unicode BiDi
 * override controls so untrusted remote peer text can never inject terminal
 * commands (OSC 52 clipboard write, title overwrite, clear screen, CR rewrite)
 * or visually spoof another participant's chat line.
 */

// 1) OSC (ESC ] ... BEL/ST, or 8-bit 0x9D ... BEL/ST/0x9C)
const OSC_SEQUENCE_RE =
  /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g;
// 2) DCS / SOS / PM / APC string-terminated sequences
const STRING_CONTROL_SEQUENCE_RE =
  /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g;
// 3) CSI sequences (complete ECMA-48 CSI + unterminated CSI fragments)
const CSI_SEQUENCE_RE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g;
// 4) Other 2-byte / nF ESC sequences (e.g. ESC c, ESC ( 0, ESC 7, ESC =)
const OTHER_ESC_SEQUENCE_RE = /\x1b[ -/]*[@-~]/g;
// 5) Unicode BiDi directional formatting & isolate characters
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// 6) Remaining C0 (excluding \n), DEL, C1 control characters, plus stray ESC
const UNSAFE_MULTILINE_CONTROLS_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
const UNSAFE_SINGLELINE_CONTROLS_RE = /[\x00-\x1f\x7f-\x9f]/g;

function stripTerminalEscapeSequences(input: string): string {
  return input
    .replace(OSC_SEQUENCE_RE, "")
    .replace(STRING_CONTROL_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(OTHER_ESC_SEQUENCE_RE, "")
    .replace(BIDI_CONTROL_RE, "");
}

/**
 * Sanitizes untrusted text intended for a single-line terminal slot
 * (username, displayName, fileName, peerId, error reason).
 */
export function sanitizeTerminalSingleLine(input: string): string {
  return stripTerminalEscapeSequences(input)
    .replace(/\r\n|\r|\n|\t|\u2028|\u2029/g, " ")
    .replace(UNSAFE_SINGLELINE_CONTROLS_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Sanitizes untrusted multi-line chat body text for terminal display.
 * Preserves logical line breaks as '\n' (converting CR and Unicode line
 * separators so carriage returns cannot overwrite the current line) and
 * expands tabs to two spaces.
 */
export function sanitizeTerminalMultilineText(input: string): string {
  return stripTerminalEscapeSequences(input)
    .replace(/\r\n|\r|\u2028|\u2029/g, "\n")
    .replace(/\t/g, "  ")
    .replace(UNSAFE_MULTILINE_CONTROLS_RE, "");
}

export const CLI_MULTILINE_CONTINUATION_PREFIX = "  │ ";

/**
 * Formats a verified chat message for stdout, sanitizing both author and body
 * and indenting every continuation line with '  │ ' so multi-line payloads
 * cannot forge another participant's timestamped chat line.
 */
export function formatCliChatMessage(params: {
  readonly prefix?: string;
  readonly clock: string;
  readonly username: string;
  readonly body: string;
}): string {
  const safePrefix = params.prefix ?? "";
  const safeUser = sanitizeTerminalSingleLine(params.username);
  const safeBody = sanitizeTerminalMultilineText(params.body);
  const lines = safeBody.split("\n");
  const head = `${safePrefix}[${params.clock}] @${safeUser}: ${lines[0] ?? ""}`;
  if (lines.length <= 1) {
    return head;
  }
  const tail = lines
    .slice(1)
    .map((line) => `${CLI_MULTILINE_CONTINUATION_PREFIX}${line}`)
    .join("\n");
  return `${head}\n${tail}`;
}
