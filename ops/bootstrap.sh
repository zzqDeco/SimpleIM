#!/usr/bin/env bash
# Run once as root on the Aliyun ECS host to bootstrap /srv/simpleim, simpleim-deploy,
# initial persistent signing/TURN credentials, and automatic IP-TLS sync from teamie-caddy-1.
set -euo pipefail
umask 077

[[ ${EUID} -eq 0 ]] || { echo "Run bootstrap.sh as root." >&2; exit 1; }

DEPLOY_USER=${SIMPLEIM_DEPLOY_USER:-simpleim-deploy}
BASE_DIR=${SIMPLEIM_ROOT:-/srv/simpleim}
PUBLIC_HOST_IP=${PUBLIC_HOST_IP:-120.25.210.202}
PUBLIC_HTTPS_PORT=${PUBLIC_HTTPS_PORT:-8444}
ENABLE_COTURN=${ENABLE_COTURN:-true}
TLS_SYNC_FROM_TEAMIE=${TLS_SYNC_FROM_TEAMIE:-true}

[[ $DEPLOY_USER =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || exit 1

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$DEPLOY_HOME/.ssh"
touch "$DEPLOY_HOME/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 0600 "$DEPLOY_HOME/.ssh/authorized_keys"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 \
  "$BASE_DIR" "$BASE_DIR/config" "$BASE_DIR/state" "$BASE_DIR/backups" \
  "$BASE_DIR/incoming" "$BASE_DIR/releases"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 \
  "$BASE_DIR/tls" "$BASE_DIR/archives"

PRIVATE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
ENV_FILE="$BASE_DIR/config/production.env"
TURN_CONF="$BASE_DIR/config/turnserver.conf"

if [[ ! -f "$ENV_FILE" ]]; then
  SIGN_SEED=$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')
  TURN_SECRET=$(openssl rand -hex 32)
  if [[ "$TLS_SYNC_FROM_TEAMIE" == "true" ]]; then
    TLS_CFG="./tls/certificate-files.caddy"
  else
    TLS_CFG="./tls/acme-ip.caddy"
  fi

  cat > "$ENV_FILE" <<EOF
PUBLIC_HTTPS_PORT=${PUBLIC_HTTPS_PORT}
CADDY_HTTPS_PORT=${PUBLIC_HTTPS_PORT}
SITE_ADDRESS=https://${PUBLIC_HOST_IP}:${PUBLIC_HTTPS_PORT}
TLS_SERVER_NAME=${PUBLIC_HOST_IP}
TLS_CONFIG_FILE=${TLS_CFG}
TLS_CERT_DIR=${BASE_DIR}/tls
TLS_SYNC_FROM_TEAMIE=${TLS_SYNC_FROM_TEAMIE}
ALLOWED_ORIGINS=https://${PUBLIC_HOST_IP}:${PUBLIC_HTTPS_PORT}
SERVER_KEY_ID=srvk_2026_01
SERVER_IDENTITY_PRIVATE_KEY=${SIGN_SEED}
ENABLE_COTURN=${ENABLE_COTURN}
STUN_URLS=stun:${PUBLIC_HOST_IP}:3478
COTURN_URLS=turn:${PUBLIC_HOST_IP}:3478?transport=udp,turn:${PUBLIC_HOST_IP}:3478?transport=tcp
COTURN_SHARED_SECRET=${TURN_SECRET}
COTURN_CONFIG_FILE=${TURN_CONF}
EOF
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"

  EXT_IP_LINE="external-ip=${PUBLIC_HOST_IP}"
  BIND_IP_LINES="listening-ip=${PUBLIC_HOST_IP}
listening-ip=127.0.0.1
relay-ip=${PUBLIC_HOST_IP}"
  if [[ -n "$PRIVATE_IP" && "$PRIVATE_IP" != "$PUBLIC_HOST_IP" ]]; then
    EXT_IP_LINE="external-ip=${PUBLIC_HOST_IP}/${PRIVATE_IP}"
    BIND_IP_LINES="listening-ip=${PRIVATE_IP}
listening-ip=127.0.0.1
relay-ip=${PRIVATE_IP}"
  fi

  cat > "$TURN_CONF" <<EOF
listening-port=3478
${BIND_IP_LINES}
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${PUBLIC_HOST_IP}
${EXT_IP_LINE}
min-port=49152
max-port=49407
log-file=stdout
simple-log
pidfile="/tmp/turnserver.pid"
no-tcp-relay
no-tls
no-dtls
no-cli
no-multicast-peers
no-loopback-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
EOF
  chown "$DEPLOY_USER:$DEPLOY_USER" "$TURN_CONF"
  chmod 0644 "$TURN_CONF"
fi

if [[ "$TLS_SYNC_FROM_TEAMIE" == "true" ]]; then
  cat > /usr/local/bin/simpleim-sync-tls.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
HOST_IP="${PUBLIC_HOST_IP}"
TLS_DIR="${BASE_DIR}/tls"
if ! docker ps --format '{{.Names}}' | grep -qx 'teamie-caddy-1'; then
  exit 0
fi
ACME_DIR="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/\${HOST_IP}"
TMP_CRT=\$(mktemp)
TMP_KEY=\$(mktemp)
trap 'rm -f -- "\$TMP_CRT" "\$TMP_KEY"' EXIT
docker exec teamie-caddy-1 cat "\${ACME_DIR}/\${HOST_IP}.crt" > "\$TMP_CRT"
docker exec teamie-caddy-1 cat "\${ACME_DIR}/\${HOST_IP}.key" > "\$TMP_KEY"
if [[ ! -s "\$TMP_CRT" || ! -s "\$TMP_KEY" ]]; then
  exit 1
fi
CHANGED=0
if [[ ! -f "\$TLS_DIR/fullchain.pem" ]] || ! cmp -s "\$TMP_CRT" "\$TLS_DIR/fullchain.pem"; then
  install -o ${DEPLOY_USER} -g ${DEPLOY_USER} -m 0644 "\$TMP_CRT" "\$TLS_DIR/fullchain.pem"
  CHANGED=1
fi
if [[ ! -f "\$TLS_DIR/privkey.pem" ]] || ! cmp -s "\$TMP_KEY" "\$TLS_DIR/privkey.pem"; then
  install -o ${DEPLOY_USER} -g ${DEPLOY_USER} -m 0644 "\$TMP_KEY" "\$TLS_DIR/privkey.pem"
  CHANGED=1
fi
if [[ "\$CHANGED" -eq 1 ]] && docker ps --format '{{.Names}}' | grep -qx 'simpleim-caddy-1'; then
  docker restart simpleim-caddy-1 >/dev/null
fi
EOF
  chmod 0755 /usr/local/bin/simpleim-sync-tls.sh
  /usr/local/bin/simpleim-sync-tls.sh

  cat > /etc/systemd/system/simpleim-tls-sync.service <<'EOF'
[Unit]
Description=Sync Let's Encrypt IP certificate from teamie-caddy into simpleim
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/simpleim-sync-tls.sh
EOF

  cat > /etc/systemd/system/simpleim-tls-sync.timer <<'EOF'
[Unit]
Description=Periodic TLS certificate sync for simpleim

[Timer]
OnBootSec=2min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now simpleim-tls-sync.timer
fi

echo "SimpleIM bootstrap complete under ${BASE_DIR} (user=${DEPLOY_USER}, https=:${PUBLIC_HTTPS_PORT}, coturn=${ENABLE_COTURN})."
