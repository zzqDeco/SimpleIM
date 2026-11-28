import { resolve } from "node:path";

export class CliSecurityError extends Error {
  readonly code = "insecure_secret_flag";

  constructor(message: string) {
    super(message);
    this.name = "CliSecurityError";
  }
}

export class CliUsageError extends Error {
  readonly code = "invalid_cli_arguments";

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type ParsedCliCommand =
  | {
      command: "help";
      topic?: string;
    }
  | {
      command: "version";
    }
  | {
      command: "register";
      serverUrl?: string;
      configDir?: string;
      username?: string;
      displayName?: string;
      passwordStdin: boolean;
      json: boolean;
    }
  | {
      command: "login";
      serverUrl?: string;
      configDir?: string;
      username?: string;
      passwordStdin: boolean;
      json: boolean;
    }
  | {
      command: "logout";
      serverUrl?: string;
      configDir?: string;
      json: boolean;
    }
  | {
      command: "whoami";
      serverUrl?: string;
      configDir?: string;
      json: boolean;
    }
  | {
      command: "join";
      serverUrl?: string;
      configDir?: string;
      downloadDir: string;
      passphraseStdin: boolean;
      json: boolean;
    }
  | {
      command: "seed";
      serverUrl?: string;
      configDir?: string;
      storageDir: string;
      maxStorageMb: number;
      passphraseStdin: boolean;
      json: boolean;
    };

declare const __SIMPLEIM_DEFAULT_SERVER_URL__: string | undefined;

export const DEFAULT_SERVER_URL =
  typeof __SIMPLEIM_DEFAULT_SERVER_URL__ === "string" &&
  __SIMPLEIM_DEFAULT_SERVER_URL__.trim().length > 0
    ? __SIMPLEIM_DEFAULT_SERVER_URL__.trim()
    : "http://127.0.0.1:3000";
export const DEFAULT_MAX_STORAGE_MB = 1024;

function assertNoPlaintextSecretFlags(argv: readonly string[]): void {
  for (const token of argv) {
    if (
      token === "--passphrase" ||
      token.startsWith("--passphrase=") ||
      token === "--room-passphrase" ||
      token.startsWith("--room-passphrase=") ||
      token === "-p" ||
      token.startsWith("-p=")
    ) {
      throw new CliSecurityError(
        "Refusing plaintext --passphrase / -p flag: command-line arguments are exposed in OS process tables (ps). Omit the flag to enter the room passphrase interactively with hidden echo, or pipe it via --passphrase-stdin.",
      );
    }
    if (token === "--password" || token.startsWith("--password=")) {
      throw new CliSecurityError(
        "Refusing plaintext --password flag: command-line arguments are exposed in OS process tables (ps). Omit the flag to enter your password interactively with hidden echo, or pipe it via --password-stdin.",
      );
    }
  }
}

interface RawFlags {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

const VALUE_FLAGS = new Set([
  "--server",
  "--config-dir",
  "--username",
  "-u",
  "--display-name",
  "--download-dir",
  "--storage-dir",
  "--max-storage-mb",
]);

const BOOLEAN_FLAGS = new Set([
  "--passphrase-stdin",
  "--password-stdin",
  "--json",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const FLAG_ALIASES: Record<string, string> = {
  "-u": "--username",
  "-h": "--help",
  "-v": "--version",
};

function tokenizeArgv(argv: readonly string[]): RawFlags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;

    if (!raw.startsWith("-") || raw === "-") {
      positionals.push(raw);
      continue;
    }

    const eqIdx = raw.indexOf("=");
    const rawFlag = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inlineValue = eqIdx >= 0 ? raw.slice(eqIdx + 1) : undefined;
    const canonical = FLAG_ALIASES[rawFlag] ?? rawFlag;

    if (BOOLEAN_FLAGS.has(rawFlag) || BOOLEAN_FLAGS.has(canonical)) {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`Flag ${rawFlag} does not accept a value`);
      }
      booleans.add(canonical);
      continue;
    }

    if (VALUE_FLAGS.has(rawFlag) || VALUE_FLAGS.has(canonical)) {
      let val = inlineValue;
      if (val === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          throw new CliUsageError(`Flag ${rawFlag} requires a value`);
        }
        val = next;
        i++;
      }
      if (val.trim().length === 0) {
        throw new CliUsageError(`Flag ${rawFlag} cannot be empty`);
      }
      values.set(canonical, val);
      continue;
    }

    throw new CliUsageError(`Unknown option '${rawFlag}'. Run 'simpleim --help' for usage.`);
  }

  return { positionals, values, booleans };
}

function rejectDisallowedFlags(
  command: string,
  parsed: RawFlags,
  allowedValueFlags: readonly string[],
  allowedBooleanFlags: readonly string[],
): void {
  const allowedVal = new Set(["--server", "--config-dir", ...allowedValueFlags]);
  const allowedBool = new Set(["--json", ...allowedBooleanFlags]);

  for (const key of parsed.values.keys()) {
    if (!allowedVal.has(key)) {
      throw new CliUsageError(`Option '${key}' is not supported by 'simpleim ${command}'`);
    }
  }
  for (const key of parsed.booleans) {
    if (!allowedBool.has(key)) {
      throw new CliUsageError(`Option '${key}' is not supported by 'simpleim ${command}'`);
    }
  }
}

export function parseCliArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): ParsedCliCommand {
  assertNoPlaintextSecretFlags(argv);

  const parsed = tokenizeArgv(argv);

  if (parsed.booleans.has("--version") || parsed.positionals[0] === "version") {
    return { command: "version" };
  }

  if (parsed.booleans.has("--help")) {
    return { command: "help", topic: parsed.positionals[0] };
  }

  const subcommand = parsed.positionals[0];
  if (!subcommand || subcommand === "help") {
    return { command: "help", topic: parsed.positionals[1] };
  }

  if (parsed.positionals.length > 1) {
    throw new CliUsageError(
      `Unexpected positional argument '${parsed.positionals[1]}' for 'simpleim ${subcommand}'`,
    );
  }

  const serverUrl = parsed.values.get("--server");
  const configDir = parsed.values.get("--config-dir");
  const json = parsed.booleans.has("--json");

  switch (subcommand) {
    case "register": {
      rejectDisallowedFlags(
        subcommand,
        parsed,
        ["--username", "--display-name"],
        ["--password-stdin"],
      );
      return {
        command: "register",
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
        ...(parsed.values.get("--username") !== undefined
          ? { username: parsed.values.get("--username") }
          : {}),
        ...(parsed.values.get("--display-name") !== undefined
          ? { displayName: parsed.values.get("--display-name") }
          : {}),
        passwordStdin: parsed.booleans.has("--password-stdin"),
        json,
      };
    }

    case "login": {
      rejectDisallowedFlags(
        subcommand,
        parsed,
        ["--username"],
        ["--password-stdin"],
      );
      return {
        command: "login",
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
        ...(parsed.values.get("--username") !== undefined
          ? { username: parsed.values.get("--username") }
          : {}),
        passwordStdin: parsed.booleans.has("--password-stdin"),
        json,
      };
    }

    case "logout": {
      rejectDisallowedFlags(subcommand, parsed, [], []);
      return {
        command: "logout",
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
        json,
      };
    }

    case "whoami": {
      rejectDisallowedFlags(subcommand, parsed, [], []);
      return {
        command: "whoami",
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
        json,
      };
    }

    case "join": {
      rejectDisallowedFlags(
        subcommand,
        parsed,
        ["--download-dir"],
        ["--passphrase-stdin"],
      );
      const rawDownloadDir = parsed.values.get("--download-dir") ?? "./downloads";
      return {
        command: "join",
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
        downloadDir: resolve(cwd, rawDownloadDir),
        passphraseStdin: parsed.booleans.has("--passphrase-stdin"),
        json,
      };
    }

    case "seed": {
      rejectDisallowedFlags(
        subcommand,
        parsed,
        ["--storage-dir", "--max-storage-mb"],
        ["--passphrase-stdin"],
      );
      const rawStorageDir = parsed.values.get("--storage-dir") ?? "./seed-storage";
      const rawMaxMb = parsed.values.get("--max-storage-mb");
      let maxStorageMb = DEFAULT_MAX_STORAGE_MB;
      if (rawMaxMb !== undefined) {
        const num = Number(rawMaxMb);
        if (!Number.isFinite(num) || num <= 0) {
          throw new CliUsageError(
            "--max-storage-mb must be a positive number (e.g. --max-storage-mb 512)",
          );
        }
        maxStorageMb = num;
      }
      return {
        command: "seed",
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(configDir !== undefined ? { configDir } : {}),
        storageDir: resolve(cwd, rawStorageDir),
        maxStorageMb,
        passphraseStdin: parsed.booleans.has("--passphrase-stdin"),
        json,
      };
    }

    default:
      throw new CliUsageError(
        `Unknown command '${subcommand}'. Run 'simpleim --help' for available commands.`,
      );
  }
}

export function formatHelpText(topic?: string): string {
  const normalizedTopic = topic?.trim().toLowerCase();

  switch (normalizedTopic) {
    case "register":
      return [
        "Usage: simpleim register [options]",
        "",
        "Register a new SimpleIM account and save session credentials locally.",
        "",
        "Options:",
        "  --server <url>         Central server URL (prompted on first TTY run if unset)",
        "  -u, --username <name>  Username (3..24 chars: [a-z0-9_-])",
        "  --display-name <name>  Optional display name shown to room peers",
        "  --password-stdin       Read password from stdin instead of hidden TTY prompt",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim)",
        "  --json                 Emit machine-readable JSON output",
        "",
        "Security Note:",
        "  Plaintext --password flags are forbidden. On a TTY, password is entered",
        "  with hidden echo and confirmed twice.",
      ].join("\n");

    case "login":
      return [
        "Usage: simpleim login [options]",
        "",
        "Sign in to an existing SimpleIM account and save session credentials locally.",
        "",
        "Options:",
        "  --server <url>         Central server URL (prompted on first TTY run if unset)",
        "  -u, --username <name>  Account username",
        "  --password-stdin       Read password from stdin instead of hidden TTY prompt",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim)",
        "  --json                 Emit machine-readable JSON output",
      ].join("\n");

    case "logout":
      return [
        "Usage: simpleim logout [options]",
        "",
        "Revoke the current session on the server and remove saved local credentials.",
        "",
        "Options:",
        "  --server <url>         Verify server URL matches stored credentials",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim)",
        "  --json                 Emit machine-readable JSON output",
      ].join("\n");

    case "whoami":
      return [
        "Usage: simpleim whoami [options]",
        "",
        "Verify saved session credentials against the server and show account info.",
        "",
        "Options:",
        "  --server <url>         Verify server URL matches stored credentials",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim)",
        "  --json                 Emit machine-readable JSON output",
      ].join("\n");

    case "join":
      return [
        "Usage: simpleim join [options]",
        "",
        "Derive E2EE room keys locally from a shared passphrase and join a P2P room.",
        "",
        "Options:",
        "  --server <url>         Central signaling server URL (or SIMPLEIM_SERVER_URL)",
        "  --download-dir <dir>   Download folder (default: ./downloads, relative to cwd)",
        "  --passphrase-stdin     Read passphrase from stdin (stays connected on EOF until Ctrl+C)",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim)",
        "  --json                 Emit newline-delimited JSON (NDJSON) events to stdout",
        "",
        "In-Room Slash Commands:",
        "  /peers                       List verified P2P peers and signaling state",
        "  /send <filepath>             Share a local file (supports ~, quotes, and escaped spaces)",
        "  /files                       List announced files and transfer/relay progress",
        "  /get <fileId|index>          Download or resume an announced file",
        "  /cancel <fileId|index>       Cancel an in-progress download",
        "  /reply <msgId|last> <text>   Reply quoting an earlier message",
        "  /retry                       Retry pending offline-relay chat messages",
        "  /help                        Show in-room command reference",
        "  /leave, /quit                Disconnect from room and wipe room keys",
      ].join("\n");

    case "seed":
      return [
        "Usage: simpleim seed [options]",
        "",
        "Run a headless P2P seed peer that caches signed chat & files within a disk quota.",
        "",
        "Options:",
        "  --server <url>         Central signaling server URL (or SIMPLEIM_SERVER_URL)",
        "  --storage-dir <dir>    Seed storage directory (default: ./seed-storage, relative to cwd)",
        "  --max-storage-mb <N>   Maximum disk quota in MiB (default: 1024)",
        "  --passphrase-stdin     Read passphrase from stdin",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim)",
        "  --json                 Emit structured NDJSON logs to stdout (default: human-readable)",
      ].join("\n");

    default:
      return [
        "SimpleIM CLI — E2EE Peer-to-Peer Chat & Swarm File Transfer",
        "",
        "Usage:",
        "  simpleim register [--server <url>] [-u|--username <u>] [--display-name <d>]",
        "  simpleim login    [--server <url>] [-u|--username <u>]",
        "  simpleim logout   [--server <url>]",
        "  simpleim whoami   [--server <url>]",
        "  simpleim join     [--server <url>] [--download-dir <dir>] [--passphrase-stdin]",
        "  simpleim seed     [--server <url>] [--storage-dir <dir>] [--max-storage-mb <N>] [--passphrase-stdin]",
        "",
        "Global Options:",
        "  --server <url>         Central auth & signaling server URL (or SIMPLEIM_SERVER_URL)",
        "  --config-dir <dir>     Credential directory (default: ~/.config/simpleim or SIMPLEIM_CONFIG_DIR)",
        "  --json                 Emit machine-readable JSON / NDJSON output",
        "  -h, --help             Show help (run 'simpleim <command> --help' for command details)",
        "  -v, --version          Show CLI version",
        "",
        "Defaults & Environment:",
        "  Downloads default to ./downloads (relative to current working directory).",
        "  Set NO_COLOR=1 to disable ANSI color output.",
        "",
        "Security Note:",
        "  Plaintext --passphrase / -p and --password flags are strictly forbidden to",
        "  prevent leaking secrets in OS process tables. Enter secrets interactively",
        "  with hidden echo or pipe them via --passphrase-stdin / --password-stdin.",
      ].join("\n");
  }
}
