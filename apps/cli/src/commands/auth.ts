import {
  CliApiClient,
  CliApiError,
  normalizeServerUrl,
} from "../api-client.ts";
import { DEFAULT_SERVER_URL, type ParsedCliCommand } from "../args.ts";
import { CredentialStore, type StoredCredentials } from "../credentials.ts";
import { readSecret, readVisiblePrompt } from "../passphrase.ts";
import { isTtyStream } from "../terminal-io.ts";

const USERNAME_LOCAL_RE = /^[a-z0-9_-]{3,24}$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;

export interface CommandIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export function resolveEffectiveServerUrl(
  explicitServerUrl?: string,
  storedServerUrl?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicitServerUrl && explicitServerUrl.trim().length > 0) {
    return normalizeServerUrl(explicitServerUrl);
  }
  if (env.SIMPLEIM_SERVER_URL && env.SIMPLEIM_SERVER_URL.trim().length > 0) {
    return normalizeServerUrl(env.SIMPLEIM_SERVER_URL);
  }
  if (storedServerUrl && storedServerUrl.trim().length > 0) {
    return normalizeServerUrl(storedServerUrl);
  }
  if (
    env.SIMPLEIM_DEFAULT_SERVER_URL &&
    env.SIMPLEIM_DEFAULT_SERVER_URL.trim().length > 0
  ) {
    return normalizeServerUrl(env.SIMPLEIM_DEFAULT_SERVER_URL);
  }
  return DEFAULT_SERVER_URL;
}

async function resolveInteractiveAuthServerUrl(params: {
  explicitServerUrl?: string;
  storedServerUrl?: string;
  env?: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  stderr: NodeJS.WritableStream;
  passwordStdin: boolean;
  json: boolean;
}): Promise<string> {
  const env = params.env ?? process.env;
  const hasConfiguredServer = Boolean(
    (params.explicitServerUrl && params.explicitServerUrl.trim().length > 0) ||
      (env.SIMPLEIM_SERVER_URL && env.SIMPLEIM_SERVER_URL.trim().length > 0) ||
      (params.storedServerUrl && params.storedServerUrl.trim().length > 0),
  );

  const fallbackDefault = resolveEffectiveServerUrl(
    params.explicitServerUrl,
    params.storedServerUrl,
    env,
  );

  if (
    !hasConfiguredServer &&
    !params.passwordStdin &&
    !params.json &&
    isTtyStream(params.stdin)
  ) {
    const entered = await readVisiblePrompt({
      prompt: `Server URL [${fallbackDefault}]: `,
      stdin: params.stdin,
      stderr: params.stderr,
    });
    return normalizeServerUrl(entered.length > 0 ? entered : fallbackDefault);
  }

  return fallbackDefault;
}

export function withNetworkServerHint(err: unknown, serverUrl: string): unknown {
  if (err instanceof CliApiError && err.code === "network_error") {
    return new CliApiError(
      "network_error",
      `Could not connect to server at ${serverUrl} (${err.message}). Pass --server <url> or set SIMPLEIM_SERVER_URL.`,
      err.status,
    );
  }
  return err;
}

export function validateRegisterUsernameLocal(rawUsername: string): string {
  const normalized = rawUsername.trim().toLowerCase();
  if (!USERNAME_LOCAL_RE.test(normalized)) {
    throw new Error(
      "Invalid username: must be 3..24 characters using only lowercase letters, digits, '_' or '-'.",
    );
  }
  return normalized;
}

export async function requireValidCredentials(
  store: CredentialStore,
  explicitServerUrl?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<StoredCredentials> {
  const creds = await store.load();
  if (!creds) {
    throw new Error(
      `Not logged in (no credentials at ${store.filePath}). Run 'simpleim login' or 'simpleim register' first.`,
    );
  }
  if (creds.expiresAt <= Date.now()) {
    throw new Error(
      "Saved session has expired. Run 'simpleim login' to authenticate again.",
    );
  }
  const targetUrl = resolveEffectiveServerUrl(
    explicitServerUrl,
    creds.serverUrl,
    env,
  );
  if (normalizeServerUrl(creds.serverUrl) !== targetUrl) {
    throw new Error(
      `Stored credentials belong to ${creds.serverUrl}, not ${targetUrl}. Run 'simpleim login --server ${targetUrl}' first.`,
    );
  }
  return creds;
}

export async function runRegisterCommand(
  cmd: Extract<ParsedCliCommand, { command: "register" }>,
  io: CommandIo = {},
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const existing = await store.load().catch(() => null);
  const serverUrl = await resolveInteractiveAuthServerUrl({
    explicitServerUrl: cmd.serverUrl,
    storedServerUrl: existing?.serverUrl,
    env: io.env,
    stdin,
    stderr,
    passwordStdin: cmd.passwordStdin,
    json: cmd.json,
  });

  const interactiveTty = !cmd.passwordStdin && isTtyStream(stdin);

  const rawUsername =
    cmd.username ??
    (await readVisiblePrompt({
      prompt: "Username (3..24 [a-z0-9_-]): ",
      stdin,
      stderr,
    }));
  const username = validateRegisterUsernameLocal(rawUsername);

  let displayName = cmd.displayName;
  if (displayName === undefined && interactiveTty && !cmd.json) {
    const enteredDisplayName = await readVisiblePrompt({
      prompt: `Display name (optional, default: ${username}): `,
      stdin,
      stderr,
    });
    if (enteredDisplayName.length > 0) {
      displayName = enteredDisplayName;
    }
  }

  const password = await readSecret({
    fromStdin: cmd.passwordStdin,
    prompt: "Password (8..128 chars): ",
    stdin,
    stderr,
  });
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LEN} and ${MAX_PASSWORD_LEN} characters.`,
    );
  }

  if (interactiveTty) {
    const confirmed = await readSecret({
      fromStdin: false,
      prompt: "Confirm password: ",
      stdin,
      stderr,
    });
    if (confirmed !== password) {
      throw new Error("Passwords do not match. Registration cancelled.");
    }
  }

  const api = new CliApiClient({ serverUrl, fetchImpl: io.fetchImpl });
  let auth;
  try {
    auth = await api.register({
      username,
      password,
      ...(displayName !== undefined ? { displayName } : {}),
    });
  } catch (err) {
    throw withNetworkServerHint(err, api.serverUrl);
  }

  await store.save({
    serverUrl: api.serverUrl,
    sessionToken: auth.sessionToken,
    expiresAt: auth.expiresAt,
    user: auth.user,
  });

  if (cmd.json) {
    stdout.write(
      `${JSON.stringify({
        ok: true,
        serverUrl: api.serverUrl,
        user: auth.user,
        expiresAt: auth.expiresAt,
      })}\n`,
    );
  } else {
    stdout.write(
      `Registered and logged in as @${auth.user.username} (${auth.user.displayName}) on ${api.serverUrl}\n`,
    );
  }
}

export async function runLoginCommand(
  cmd: Extract<ParsedCliCommand, { command: "login" }>,
  io: CommandIo = {},
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const existing = await store.load().catch(() => null);
  const serverUrl = await resolveInteractiveAuthServerUrl({
    explicitServerUrl: cmd.serverUrl,
    storedServerUrl: existing?.serverUrl,
    env: io.env,
    stdin,
    stderr,
    passwordStdin: cmd.passwordStdin,
    json: cmd.json,
  });

  const username =
    cmd.username ??
    (await readVisiblePrompt({
      prompt: "Username: ",
      stdin,
      stderr,
    }));

  const password = await readSecret({
    fromStdin: cmd.passwordStdin,
    prompt: "Password: ",
    stdin,
    stderr,
  });

  const api = new CliApiClient({ serverUrl, fetchImpl: io.fetchImpl });
  let auth;
  try {
    auth = await api.login({ username, password });
  } catch (err) {
    throw withNetworkServerHint(err, api.serverUrl);
  }

  await store.save({
    serverUrl: api.serverUrl,
    sessionToken: auth.sessionToken,
    expiresAt: auth.expiresAt,
    user: auth.user,
  });

  if (cmd.json) {
    stdout.write(
      `${JSON.stringify({
        ok: true,
        serverUrl: api.serverUrl,
        user: auth.user,
        expiresAt: auth.expiresAt,
      })}\n`,
    );
  } else {
    stdout.write(
      `Logged in as @${auth.user.username} (${auth.user.displayName}) on ${api.serverUrl}\n`,
    );
  }
}

export async function runLogoutCommand(
  cmd: Extract<ParsedCliCommand, { command: "logout" }>,
  io: CommandIo = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const creds = await store.load();

  if (creds) {
    const storedUrl = normalizeServerUrl(creds.serverUrl);
    const targetUrl = resolveEffectiveServerUrl(
      cmd.serverUrl,
      creds.serverUrl,
      io.env,
    );
    if (storedUrl !== targetUrl) {
      throw new Error(
        `Stored credentials belong to ${storedUrl}, not ${targetUrl}. Omit --server / SIMPLEIM_SERVER_URL or pass --server ${storedUrl} to log out.`,
      );
    }
    const api = new CliApiClient({
      serverUrl: storedUrl,
      fetchImpl: io.fetchImpl,
    });
    try {
      await api.logout(creds.sessionToken);
    } catch {
      // Always remove local credentials even if remote session expired or server is unreachable
    }
  } else if (cmd.serverUrl || io.env?.SIMPLEIM_SERVER_URL) {
    resolveEffectiveServerUrl(cmd.serverUrl, undefined, io.env);
  }

  const removed = await store.clear();
  if (cmd.json) {
    stdout.write(`${JSON.stringify({ ok: true, cleared: removed })}\n`);
  } else {
    stdout.write(
      removed
        ? "Logged out and removed local session credentials.\n"
        : "Already logged out.\n",
    );
  }
}

export async function runWhoamiCommand(
  cmd: Extract<ParsedCliCommand, { command: "whoami" }>,
  io: CommandIo = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const creds = await requireValidCredentials(store, cmd.serverUrl, io.env);

  const api = new CliApiClient({
    serverUrl: creds.serverUrl,
    fetchImpl: io.fetchImpl,
  });
  let me;
  try {
    me = await api.getMe(creds.sessionToken);
  } catch (err) {
    throw withNetworkServerHint(err, api.serverUrl);
  }

  if (cmd.json) {
    stdout.write(
      `${JSON.stringify({
        ok: true,
        serverUrl: api.serverUrl,
        user: me.user,
        expiresAt: creds.expiresAt,
      })}\n`,
    );
  } else {
    stdout.write(
      [
        `User:        @${me.user.username} (${me.user.displayName})`,
        `User ID:     ${me.user.id}`,
        `Server:      ${api.serverUrl}`,
        `Expires At:  ${new Date(creds.expiresAt).toISOString()}`,
      ].join("\n") + "\n",
    );
  }
}
