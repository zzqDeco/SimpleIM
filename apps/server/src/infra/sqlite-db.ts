import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientKind } from "@simpleim/contracts";
import {
  DomainError,
  type Session,
  type SessionRepositoryPort,
  type User,
  type UserRepositoryPort,
} from "../domain/index.ts";

interface MigrationDefinition {
  readonly version: number;
  readonly sql: string;
}

const MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY NOT NULL,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_sha256 BLOB NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
        client_kind TEXT NOT NULL CHECK (client_kind IN ('web', 'cli')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `,
  },
];

export function openAndMigrateSqliteDb(
  sqlitePath = ":memory:",
  nowMs: number = Date.now(),
): Database {
  if (sqlitePath !== ":memory:" && !sqlitePath.startsWith("file:")) {
    const parent = dirname(sqlitePath);
    if (parent && parent !== ".") {
      mkdirSync(parent, { recursive: true });
    }
  }

  const db = new Database(sqlitePath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const appliedRows = db
    .query<{ version: number }, []>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    )
    .all();
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const applyMigration = db.transaction((migration: MigrationDefinition) => {
    db.exec(migration.sql);
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(migration.version, nowMs);
  });

  for (const migration of MIGRATIONS) {
    if (!appliedSet.has(migration.version)) {
      applyMigration(migration);
    }
  }

  return db;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

export class SqliteUserRepository implements UserRepositoryPort {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  findById(id: string): User | null {
    const row = this.db
      .query<UserRow, [string]>(
        "SELECT id, username, display_name, password_hash, created_at FROM users WHERE id = ? LIMIT 1",
      )
      .get(id);
    return row ? mapUserRow(row) : null;
  }

  findByUsername(username: string): User | null {
    const row = this.db
      .query<UserRow, [string]>(
        "SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE LIMIT 1",
      )
      .get(username);
    return row ? mapUserRow(row) : null;
  }

  create(user: User): User {
    try {
      this.db
        .query(
          "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          user.id,
          user.username,
          user.displayName,
          user.passwordHash,
          user.createdAt,
        );
      return user;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.toLowerCase().includes("unique")
      ) {
        throw new DomainError("username_taken", "Username is already taken");
      }
      throw err;
    }
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  token_sha256: Uint8Array;
  client_kind: ClientKind;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenSha256: new Uint8Array(row.token_sha256),
    clientKind: row.client_kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class SqliteSessionRepository implements SessionRepositoryPort {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(session: Session): void {
    if (session.tokenSha256.byteLength !== 32) {
      throw new Error("Session tokenSha256 must be a 32-byte SHA-256 digest");
    }
    this.db
      .query(
        `INSERT INTO sessions (
          id, user_id, token_sha256, client_kind, created_at, expires_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.userId,
        session.tokenSha256,
        session.clientKind,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
      );
  }

  findByTokenSha256(tokenSha256: Uint8Array): Session | null {
    if (tokenSha256.byteLength !== 32) {
      return null;
    }
    const row = this.db
      .query<SessionRow, [Uint8Array]>(
        `SELECT id, user_id, token_sha256, client_kind, created_at, expires_at, last_seen_at
         FROM sessions
         WHERE token_sha256 = ?
         LIMIT 1`,
      )
      .get(tokenSha256);
    return row ? mapSessionRow(row) : null;
  }

  touchLastSeen(sessionId: string, lastSeenAt: number): void {
    this.db
      .query("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .run(lastSeenAt, sessionId);
  }

  deleteById(sessionId: string): void {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  deleteExpired(nowMs: number): number {
    const res = this.db
      .query("DELETE FROM sessions WHERE expires_at <= ?")
      .run(nowMs);
    return res.changes;
  }
}
