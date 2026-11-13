import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord, isValidUserId, isValidUsername, type UserProfile } from "@simpleim/contracts";
import { bytesToHex, randomBytes } from "@simpleim/crypto";

export interface StoredCredentials {
  serverUrl: string;
  sessionToken: string;
  expiresAt: number;
  user: UserProfile;
}

export function resolveConfigDir(
  explicitConfigDir?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicitConfigDir && explicitConfigDir.trim().length > 0) {
    return resolve(explicitConfigDir.trim());
  }
  const envDir = env.SIMPLEIM_CONFIG_DIR;
  if (envDir && envDir.trim().length > 0) {
    return resolve(envDir.trim());
  }
  return join(homedir(), ".config", "simpleim");
}

function isValidStoredCredentials(value: unknown): value is StoredCredentials {
  if (!isRecord(value) || !isRecord(value.user)) {
    return false;
  }
  const u = value.user;
  return (
    typeof value.serverUrl === "string" &&
    value.serverUrl.length > 0 &&
    typeof value.sessionToken === "string" &&
    value.sessionToken.length > 0 &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    isValidUserId(u.id) &&
    isValidUsername(u.username) &&
    typeof u.displayName === "string" &&
    u.displayName.length >= 1 &&
    typeof u.createdAt === "number" &&
    Number.isSafeInteger(u.createdAt)
  );
}

export class CredentialStore {
  readonly configDir: string;
  readonly filePath: string;

  constructor(options?: { configDir?: string; env?: Record<string, string | undefined> }) {
    this.configDir = resolveConfigDir(options?.configDir, options?.env);
    this.filePath = join(this.configDir, "credentials.json");
  }

  async save(credentials: StoredCredentials): Promise<void> {
    if (!isValidStoredCredentials(credentials)) {
      throw new Error("Refusing to persist malformed credentials");
    }

    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await chmod(this.configDir, 0o700);

    const suffix = bytesToHex(randomBytes(8));
    const tmpPath = join(
      this.configDir,
      `.credentials.${process.pid}.${suffix}.tmp`,
    );
    const serialized = `${JSON.stringify(credentials, null, 2)}\n`;

    const fh = await open(tmpPath, "wx", 0o600);
    try {
      await fh.writeFile(serialized, { encoding: "utf8" });
      await chmod(tmpPath, 0o600);
      await fh.sync();
    } catch (err) {
      await fh.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    await fh.close();

    try {
      await rename(tmpPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async load(): Promise<StoredCredentials | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupted credentials JSON in ${this.filePath}`);
    }

    if (!isValidStoredCredentials(parsed)) {
      throw new Error(`Invalid credentials schema in ${this.filePath}`);
    }

    return parsed;
  }

  async clear(): Promise<boolean> {
    try {
      await stat(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return false;
      }
      throw err;
    }
    await rm(this.filePath, { force: true });
    return true;
  }
}
