#!/usr/bin/env bash
# Production deployment & rollback executor on Aliyun ECS (/srv/simpleim).
# Strictly isolated from /srv/teamie (:80/:443), /srv/drop2empire (:8443),
# /srv/teamie-werewolf (:9443), and /srv/teamie-avalon (:9444).
set -Eeuo pipefail
umask 077

MODE=${1:-}
BASE_DIR=${SIMPLEIM_ROOT:-/srv/simpleim}
CONFIG_DIR="$BASE_DIR/config"
ENV_FILE="$CONFIG_DIR/production.env"
TLS_DIR="$BASE_DIR/tls"
STATE_DIR="$BASE_DIR/state"
ARCHIVES_DIR="$BASE_DIR/archives"
BACKUPS_DIR="$BASE_DIR/backups"
LOCK_FILE="$STATE_DIR/deploy.lock"

mkdir -p "$CONFIG_DIR" "$TLS_DIR" "$STATE_DIR" "$ARCHIVES_DIR" "$BACKUPS_DIR" "$BASE_DIR/incoming" "$BASE_DIR/releases"
chmod 0700 "$BASE_DIR" "$CONFIG_DIR" "$STATE_DIR" "$BACKUPS_DIR"
chmod 0755 "$TLS_DIR" "$ARCHIVES_DIR"

exec 9>"$LOCK_FILE"
if ! flock -w 300 9; then
  echo "Another SimpleIM deployment holds the production lock." >&2
  exit 1
fi

AUTH_JSON=""
if [[ ! -t 0 ]]; then
  AUTH_JSON=$(cat || true)
fi

SCRATCH=$(mktemp -d "$STATE_DIR/deploy-XXXXXX")
trap 'rm -rf -- "$SCRATCH"' EXIT

docker_login_if_needed() {
  local image_ref="$1"
  local registry="${image_ref%%/*}"
  if [[ -z "$AUTH_JSON" ]]; then
    return 0
  fi
  export DOCKER_CONFIG="$SCRATCH/docker"
  mkdir -p "$DOCKER_CONFIG"
  chmod 0700 "$DOCKER_CONFIG"
  if [[ "$registry" == *.aliyuncs.com ]]; then
    local user pass
    user=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print(d.get("acr",{}).get("username",""))' "$AUTH_JSON")
    pass=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print(d.get("acr",{}).get("password",""))' "$AUTH_JSON")
    if [[ -n "$user" && -n "$pass" ]]; then
      printf '%s' "$pass" | docker login "$registry" --username "$user" --password-stdin >/dev/null 2>&1
    fi
  elif [[ "$registry" == "ghcr.io" ]]; then
    local user pass
    user=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print(d.get("ghcr",{}).get("username",""))' "$AUTH_JSON")
    pass=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print(d.get("ghcr",{}).get("password",""))' "$AUTH_JSON")
    if [[ -n "$user" && -n "$pass" ]]; then
      printf '%s' "$pass" | docker login ghcr.io --username "$user" --password-stdin >/dev/null 2>&1
    fi
  fi
}

validate_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: Missing $ENV_FILE. Run ops/bootstrap.sh as root first." >&2
    exit 1
  fi
  local mode_octal
  mode_octal=$(stat -c '%a' "$ENV_FILE")
  if [[ "$mode_octal" != "600" ]]; then
    echo "ERROR: $ENV_FILE must have mode 0600 (found $mode_octal)." >&2
    exit 1
  fi
  if [[ $(stat -c '%u' "$ENV_FILE") != "$(id -u)" ]]; then
    echo "ERROR: $ENV_FILE must be owned by the delivery user." >&2
    exit 1
  fi
  if grep -Eq 'REPLACE_WITH_' "$ENV_FILE"; then
    echo "ERROR: $ENV_FILE still contains unreplaced template placeholders." >&2
    exit 1
  fi
}

verify_port_safe() {
  local port="$1"
  if ss -tln | awk '{print $4}' | grep -Eq "(^|:)${port}$"; then
    if ! docker ps --filter "label=com.docker.compose.project=simpleim" --format '{{.Ports}}' | grep -q ":${port}->"; then
      echo "ERROR: TCP port ${port} is occupied by a non-simpleim service! Aborting." >&2
      exit 1
    fi
  fi
}

verify_coturn_port_safe() {
  if ss -tln | awk '{print $4}' | grep -Eq '(^|:)3478$'; then
    if ! docker ps --filter "label=com.docker.compose.project=simpleim" --filter "label=com.docker.compose.service=coturn" --format '{{.ID}}' | grep -q .; then
      echo "ERROR: Coturn port 3478 is occupied by a non-simpleim service! Aborting." >&2
      exit 1
    fi
  fi
}

probe_and_verify_stack() {
  local port="$1"
  local tls_name="$2"
  local expected_ver="$3"
  local expected_sha="$4"
  local expected_sqlite_ver="$5"
  local enable_coturn="$6"

  # 1. Verify container states & exact running version/SHA inside server and web
  local svc
  for svc in server web caddy; do
    local cid
    cid=$(docker ps --filter "label=com.docker.compose.project=simpleim" --filter "label=com.docker.compose.service=$svc" --format '{{.ID}}')
    if [[ -z "$cid" ]]; then
      echo "ERROR: Service $svc is not running." >&2
      return 1
    fi
  done

  if [[ "$enable_coturn" == "true" ]]; then
    local turn_cid turn_ok=0 turn_attempt turn_state
    turn_cid=$(docker ps -a --filter "label=com.docker.compose.project=simpleim" --filter "label=com.docker.compose.service=coturn" --format '{{.ID}}')
    if [[ -z "$turn_cid" ]]; then
      echo "ERROR: Service coturn is enabled but missing." >&2
      return 1
    fi
    for turn_attempt in $(seq 1 15); do
      turn_state=$(docker inspect -f '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$turn_cid" 2>/dev/null || true)
      if [[ "$turn_state" == "running:healthy" ]] && ss -tln | awk '{print $4}' | grep -Eq '(^|:)3478$'; then
        turn_ok=1
        break
      fi
      sleep 2
    done
    if [[ "$turn_ok" -ne 1 ]]; then
      echo "ERROR: Service coturn failed health/port probe (state=${turn_state:-unknown})." >&2
      docker logs --tail 25 "$turn_cid" >&2 || true
      return 1
    fi
  fi

  if ! docker exec -e EXPECTED_VER="$expected_ver" -e EXPECTED_SHA="$expected_sha" simpleim-server-1 bun -e '
    const r = await fetch("http://127.0.0.1:3000/api/v1/version");
    if (!r.ok) process.exit(1);
    const body = await r.json();
    if (body.version !== process.env.EXPECTED_VER || body.sha !== process.env.EXPECTED_SHA) {
      console.error("Server version mismatch:", body);
      process.exit(1);
    }
  '; then
    echo "ERROR: simpleim-server-1 /api/v1/version did not match $expected_ver ($expected_sha)." >&2
    return 1
  fi

  if ! docker exec simpleim-web-1 wget -q -O - http://127.0.0.1/version.json | python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body.get("version") == sys.argv[1] and body.get("sha") == sys.argv[2], f"web version mismatch: {body}"
' "$expected_ver" "$expected_sha"; then
    echo "ERROR: simpleim-web-1 /version.json did not match $expected_ver ($expected_sha)." >&2
    return 1
  fi

  # 2. Verify SQLite migration version and strict zero-room-persistence table invariant
  if ! docker exec -e EXPECTED_SQLITE_VER="$expected_sqlite_ver" simpleim-server-1 bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database("/data/simpleim.sqlite", { readonly: true });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = '\''table'\'' ORDER BY name ASC").all().map((r: any) => r.name);
    const expected = ["schema_migrations", "sessions", "users"];
    if (JSON.stringify(tables) !== JSON.stringify(expected)) {
      console.error("Unexpected SQLite tables:", tables);
      process.exit(1);
    }
    const row = db.query("SELECT max(version) AS v FROM schema_migrations").get() as { v: number };
    if (String(row.v) !== process.env.EXPECTED_SQLITE_VER) {
      console.error("SQLite schema version mismatch:", row);
      process.exit(1);
    }
    db.close();
  '; then
    echo "ERROR: SQLite schema or zero-room-persistence verification failed." >&2
    return 1
  fi

  # 3. Verify publicly trusted TLS certificate chain + HTTP routing without --insecure
  local base_url="https://${tls_name}:${port}"
  local connect_arg="${tls_name}:${port}:127.0.0.1:${port}"
  local attempt
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 5 --connect-to "$connect_arg" "${base_url}/healthz" | grep -q '"ok":true'; then
      local meta_json html_body unauth_code
      meta_json=$(curl --fail --silent --show-error --max-time 5 --connect-to "$connect_arg" "${base_url}/api/v1/meta" || true)
      html_body=$(curl --fail --silent --show-error --max-time 5 --connect-to "$connect_arg" "${base_url}/" || true)
      unauth_code=$(curl --silent --show-error --max-time 5 --connect-to "$connect_arg" -o /dev/null -w '%{http_code}' "${base_url}/api/v1/auth/me" || true)
      if [[ "$meta_json" == *'"serverSignPubKey"'* && "$html_body" == *'<div id="root">'* && "$unauth_code" == "401" ]]; then
        echo "Verified trusted HTTPS stack on ${base_url} (unauth=/auth/me:${unauth_code}, version=${expected_ver})"
        return 0
      fi
    fi
    sleep 2
  done

  echo "ERROR: Trusted HTTPS verification failed on ${base_url} for ${expected_ver}" >&2
  return 1
}

rollout_release_dir() {
  local rel_dir="$1"
  eval "$(python3 "$rel_dir/ops/manifest.py" verify --manifest "$rel_dir/release-manifest.json" --print-env)"

  validate_env_file
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  local port="${PUBLIC_HTTPS_PORT:-8444}"
  local tls_name="${TLS_SERVER_NAME:?TLS_SERVER_NAME required in production.env}"
  local enable_coturn="${ENABLE_COTURN:-false}"

  verify_port_safe "$port"
  if [[ "$enable_coturn" == "true" ]]; then
    verify_coturn_port_safe
  fi

  if [[ "${TLS_SYNC_FROM_TEAMIE:-false}" == "true" ]]; then
    TLS_CERT_DIR="$TLS_DIR" bash "$rel_dir/ops/sync-tls-cert.sh" "$tls_name"
  fi

  # Load bundled offline or delta OCI layer archive if present (avoids Mainland China Docker Hub / GHCR timeouts)
  if [[ -f "$rel_dir/simpleim-images-delta.tar.gz" ]]; then
    python3 "$rel_dir/ops/oci_delta.py" unpack-to-docker \
      --input "$rel_dir/simpleim-images-delta.tar.gz" \
      --cache-dir "$STATE_DIR/oci-blobs" | docker load >/dev/null
    rm -f "$rel_dir/simpleim-images-delta.tar.gz"
  elif [[ -f "$rel_dir/simpleim-images.tar.gz" ]]; then
    gzip -dc "$rel_dir/simpleim-images.tar.gz" | docker load >/dev/null
    rm -f "$rel_dir/simpleim-images.tar.gz"
  fi

  local img
  for img in "$SERVER_IMAGE" "$WEB_IMAGE" "$CADDY_IMAGE" "$COTURN_IMAGE"; do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      docker_login_if_needed "$img"
      docker pull --quiet "$img" >/dev/null
    fi
  done
  rm -rf -- "$SCRATCH/docker"
  unset DOCKER_CONFIG || true

  cat > "$SCRATCH/images.env" <<EOF
SERVER_IMAGE=${SERVER_IMAGE}
WEB_IMAGE=${WEB_IMAGE}
CADDY_IMAGE=${CADDY_IMAGE}
COTURN_IMAGE=${COTURN_IMAGE}
EOF

  # Ensure non-secret bind-mounted config files are readable under cap_drop=[ALL] (no CAP_DAC_OVERRIDE)
  chmod 0755 "$rel_dir"
  chmod -R u+rwX,go+rX "$rel_dir/deploy"

  local compose_args=(
    --project-name simpleim
    --project-directory "$rel_dir/deploy"
    --env-file "$ENV_FILE"
    --env-file "$SCRATCH/images.env"
    -f "$rel_dir/deploy/compose.production.yaml"
  )
  if [[ "$enable_coturn" == "true" ]]; then
    compose_args+=(--profile turn)
  fi

  docker compose "${compose_args[@]}" up -d --wait --wait-timeout 120 --remove-orphans
  probe_and_verify_stack "$port" "$tls_name" "$RELEASE_VERSION" "$RELEASE_SHA" "$SQLITE_SCHEMA_VERSION" "$enable_coturn"
}

if [[ "$MODE" == "apply" ]]; then
  TARGET_DIR=$(realpath "${2:?release directory required}")
  [[ "$TARGET_DIR" == "$BASE_DIR/releases/"* ]] || { echo "Release directory must reside under $BASE_DIR/releases/." >&2; exit 1; }

  CHECKS=()
  if [[ -f "$BASE_DIR/current/release-manifest.json" ]]; then
    CHECKS+=(--current "$BASE_DIR/current/release-manifest.json")
  fi
  if [[ -f "$STATE_DIR/highwater.json" ]]; then
    CHECKS+=(--highwater "$STATE_DIR/highwater.json")
  fi
  python3 "$TARGET_DIR/ops/manifest.py" check "$TARGET_DIR/release-manifest.json" "${CHECKS[@]}"

  PREV_DIR=""
  if [[ -L "$BASE_DIR/current" ]]; then
    PREV_DIR=$(readlink -f "$BASE_DIR/current" || true)
    if [[ -n "$PREV_DIR" && -f "$PREV_DIR/ops/backup.sh" ]]; then
      SIMPLEIM_DEPLOY_LOCK_HELD=1 SIMPLEIM_ROOT="$BASE_DIR" bash "$PREV_DIR/ops/backup.sh"
    fi
  fi

  if rollout_release_dir "$TARGET_DIR"; then
    eval "$(python3 "$TARGET_DIR/ops/manifest.py" verify --manifest "$TARGET_DIR/release-manifest.json" --print-env)"
    if [[ -n "$PREV_DIR" && -d "$PREV_DIR" ]]; then
      ln -sfn "$PREV_DIR" "$BASE_DIR/previous.next"
      mv -Tf "$BASE_DIR/previous.next" "$BASE_DIR/previous"
    fi
    ln -sfn "$TARGET_DIR" "$BASE_DIR/current.next"
    mv -Tf "$BASE_DIR/current.next" "$BASE_DIR/current"
    ln -sfn "$TARGET_DIR" "$ARCHIVES_DIR/$RELEASE_VERSION"
    cp "$TARGET_DIR/release-manifest.json" "$STATE_DIR/highwater.next"
    mv -f "$STATE_DIR/highwater.next" "$STATE_DIR/highwater.json"
    echo "Successfully deployed SimpleIM $RELEASE_VERSION ($RELEASE_SHA)"
  else
    if [[ -n "$PREV_DIR" && -d "$PREV_DIR" ]]; then
      echo "Rollout failed; restoring previous release: $PREV_DIR" >&2
      rollout_release_dir "$PREV_DIR" || echo "Automatic restoration failed; operator attention required." >&2
    fi
    exit 1
  fi

elif [[ "$MODE" == "rollback" ]]; then
  ROLLBACK_VERSION=${2:?rollback version required}
  EXPECTED_CURRENT_SHA=${3:?expected current sha required}
  SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

  if [[ ! -L "$BASE_DIR/current" ]]; then
    echo "No active current deployment symlink found." >&2
    exit 1
  fi
  CURRENT_DIR=$(readlink -f "$BASE_DIR/current")
  CURRENT_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$CURRENT_DIR/release-manifest.json")
  if [[ "$CURRENT_SHA" != "$EXPECTED_CURRENT_SHA" ]]; then
    echo "Current SHA mismatch: expected $EXPECTED_CURRENT_SHA, got $CURRENT_SHA" >&2
    exit 1
  fi

  ARCHIVE_TARGET=$(readlink -f "$ARCHIVES_DIR/$ROLLBACK_VERSION" || true)
  if [[ -z "$ARCHIVE_TARGET" || ! -d "$ARCHIVE_TARGET" ]]; then
    echo "Archived version $ROLLBACK_VERSION not found in $ARCHIVES_DIR" >&2
    exit 1
  fi

  python3 "$SCRIPT_DIR/manifest.py" check "$ARCHIVE_TARGET/release-manifest.json" \
    --current "$CURRENT_DIR/release-manifest.json" --rollback

  SIMPLEIM_DEPLOY_LOCK_HELD=1 SIMPLEIM_ROOT="$BASE_DIR" bash "$SCRIPT_DIR/backup.sh"
  rollout_release_dir "$ARCHIVE_TARGET"

  ln -sfn "$CURRENT_DIR" "$BASE_DIR/previous.next"
  mv -Tf "$BASE_DIR/previous.next" "$BASE_DIR/previous"
  ln -sfn "$ARCHIVE_TARGET" "$BASE_DIR/current.next"
  mv -Tf "$BASE_DIR/current.next" "$BASE_DIR/current"
  echo "Successfully rolled back SimpleIM to $ROLLBACK_VERSION"
else
  echo "Usage: deploy.sh <apply|rollback> ..." >&2
  exit 1
fi
