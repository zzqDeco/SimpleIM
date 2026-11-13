import { CliApiClient, normalizeServerUrl } from "../api-client.ts";
import { DEFAULT_SERVER_URL, type ParsedCliCommand } from "../args.ts";
import { CredentialStore, type StoredCredentials } from "../credentials.ts";
import { readSecret, readVisiblePrompt } from "../passphrase.ts";

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
  return DEFAULT_SERVER_URL;
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
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const existing = await store.load().catch(() => null);
  const serverUrl = resolveEffectiveServerUrl(
    cmd.serverUrl,
    existing?.serverUrl,
    io.env,
  );

  const username =
    cmd.username ??
    (await readVisiblePrompt({
      prompt: "Username (3..24 [a-z0-9_-]): ",
      stdin: io.stdin,
      stderr,
    }));

  const password = await readSecret({
    fromStdin: cmd.passwordStdin,
    prompt: "Password (8..128 chars): ",
    stdin: io.stdin,
    stderr,
  });

  const api = new CliApiClient({ serverUrl, fetchImpl: io.fetchImpl });
  const auth = await api.register({
    username,
    password,
    ...(cmd.displayName !== undefined ? { displayName: cmd.displayName } : {}),
  });

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
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const store = new CredentialStore({ configDir: cmd.configDir, env: io.env });
  const existing = await store.load().catch(() => null);
  const serverUrl = resolveEffectiveServerUrl(
    cmd.serverUrl,
    existing?.serverUrl,
    io.env,
  );

  const username =
    cmd.username ??
    (await readVisiblePrompt({
      prompt: "Username: ",
      stdin: io.stdin,
      stderr,
    }));

  const password = await readSecret({
    fromStdin: cmd.passwordStdin,
    prompt: "Password: ",
    stdin: io.stdin,
    stderr,
  });

  const api = new CliApiClient({ serverUrl, fetchImpl: io.fetchImpl });
  const auth = await api.login({ username, password });

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
    const serverUrl = resolveEffectiveServerUrl(
      cmd.serverUrl,
      creds.serverUrl,
      io.env,
    );
    const api = new CliApiClient({ serverUrl, fetchImpl: io.fetchImpl });
    try {
      await api.logout(creds.sessionToken);
    } catch {
      // Always remove local credentials even if remote session expired or server is unreachable
    }
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
  const me = await api.getMe(creds.sessionToken);

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
