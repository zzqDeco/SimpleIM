#!/usr/bin/env bash
# Syncs the public IP certificate managed by teamie-caddy-1 into /srv/simpleim/tls
# without modifying or restarting any container in /srv/teamie, /srv/drop2empire,
# /srv/teamie-avalon, or /srv/teamie-werewolf.
set -euo pipefail

HOST_IP=${1:-120.25.210.202}
TLS_DIR=${TLS_CERT_DIR:-/srv/simpleim/tls}

mkdir -p "$TLS_DIR"
chmod 0755 "$TLS_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx 'teamie-caddy-1'; then
  if [[ -s "$TLS_DIR/fullchain.pem" && -s "$TLS_DIR/privkey.pem" ]]; then
    exit 0
  fi
  echo "ERROR: teamie-caddy-1 is not running and no existing TLS certificate exists in $TLS_DIR" >&2
  exit 1
fi

ACME_DIR="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${HOST_IP}"
TMP_CRT=$(mktemp)
TMP_KEY=$(mktemp)
trap 'rm -f -- "$TMP_CRT" "$TMP_KEY"' EXIT

docker exec teamie-caddy-1 cat "${ACME_DIR}/${HOST_IP}.crt" > "$TMP_CRT"
docker exec teamie-caddy-1 cat "${ACME_DIR}/${HOST_IP}.key" > "$TMP_KEY"

if [[ ! -s "$TMP_CRT" || ! -s "$TMP_KEY" ]]; then
  echo "ERROR: Extracted empty TLS certificate or key from teamie-caddy-1" >&2
  exit 1
fi

CHANGED=0
if [[ ! -f "$TLS_DIR/fullchain.pem" ]] || ! cmp -s "$TMP_CRT" "$TLS_DIR/fullchain.pem"; then
  install -m 0644 "$TMP_CRT" "$TLS_DIR/fullchain.pem"
  CHANGED=1
fi
if [[ ! -f "$TLS_DIR/privkey.pem" ]] || ! cmp -s "$TMP_KEY" "$TLS_DIR/privkey.pem"; then
  install -m 0644 "$TMP_KEY" "$TLS_DIR/privkey.pem"
  CHANGED=1
fi

if [[ "$CHANGED" -eq 1 ]]; then
  if docker ps --format '{{.Names}}' | grep -qx 'simpleim-caddy-1'; then
    docker restart simpleim-caddy-1 >/dev/null
  fi
fi
