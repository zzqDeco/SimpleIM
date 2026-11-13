#!/usr/bin/env bash
# Online WAL-safe SQLite backup for SimpleIM (/srv/simpleim/backups).
# Backs up ONLY users + hashed sessions (no room/chat/file state exists on server).
set -euo pipefail
umask 077

SIMPLEIM_ROOT=${SIMPLEIM_ROOT:-/srv/simpleim}
BACKUP_DIR="$SIMPLEIM_ROOT/backups"
LOCK_FILE="$SIMPLEIM_ROOT/state/deploy.lock"

mkdir -p "$BACKUP_DIR" "$SIMPLEIM_ROOT/state"
chmod 0700 "$BACKUP_DIR"

if [[ "${SIMPLEIM_DEPLOY_LOCK_HELD:-0}" != "1" ]]; then
  exec 9>"$LOCK_FILE"
  flock -s -w 120 9 || { echo "Unable to acquire shared deploy lock for backup." >&2; exit 1; }
fi

if ! docker ps --format '{{.Names}}' | grep -qx 'simpleim-server-1'; then
  echo "simpleim-server-1 is not running; skipping online SQLite snapshot." >&2
  exit 0
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST_DIR="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST_DIR"
chmod 0700 "$DEST_DIR"

cleanup_failed() {
  rm -rf -- "$DEST_DIR"
}
trap cleanup_failed ERR

docker exec simpleim-server-1 bun -e '
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
const snap = "/tmp/simpleim-online-backup.sqlite";
rmSync(snap, { force: true });
const db = new Database("/data/simpleim.sqlite", { readonly: true });
db.exec(`VACUUM INTO "${snap}";`);
db.close();
const verify = new Database(snap, { readonly: true });
const check = verify.query("PRAGMA integrity_check").get() as { integrity_check: string };
if (check.integrity_check !== "ok") {
  throw new Error("SQLite backup integrity_check failed: " + check.integrity_check);
}
verify.close();
'

docker exec simpleim-server-1 cat /tmp/simpleim-online-backup.sqlite > "$DEST_DIR/simpleim.sqlite"
docker exec simpleim-server-1 rm -f /tmp/simpleim-online-backup.sqlite
chmod 0600 "$DEST_DIR/simpleim.sqlite"

if [[ -f "$SIMPLEIM_ROOT/current/release-manifest.json" ]]; then
  cp "$SIMPLEIM_ROOT/current/release-manifest.json" "$DEST_DIR/release-manifest.json"
fi

(
  cd "$DEST_DIR"
  sha256sum ./* > SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

trap - ERR

# Retain completed backups for 14 days
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
echo "Completed online SQLite backup: $DEST_DIR"
