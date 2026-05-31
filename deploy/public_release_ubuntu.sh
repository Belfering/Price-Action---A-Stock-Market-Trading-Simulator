#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-tradingsimulator.io}"
APP_DIR="${APP_DIR:-/opt/price-action}"
APP_PORT="${APP_PORT:-8080}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root on the Ubuntu server." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}" ]]; then
  echo "Missing app directory: ${APP_DIR}" >&2
  exit 1
fi

apt-get update
apt-get install -y caddy

ufw allow 80/tcp
ufw allow 443/tcp

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN}, www.${DOMAIN} {
    encode gzip zstd

    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "same-origin"
        Permissions-Policy "geolocation=(), microphone=(), camera=()"
    }

    reverse_proxy 127.0.0.1:${APP_PORT}
}
EOF

if [[ -f "${APP_DIR}/.env" ]]; then
  if grep -q '^COOKIE_SECURE=' "${APP_DIR}/.env"; then
    sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' "${APP_DIR}/.env"
  else
    printf '\nCOOKIE_SECURE=true\n' >> "${APP_DIR}/.env"
  fi
fi

systemctl enable --now caddy
systemctl reload caddy

cd "${APP_DIR}"
docker compose up -d

echo "Public release configured for ${DOMAIN}."
echo "Verify DNS points ${DOMAIN} and www.${DOMAIN} to this server before relying on HTTPS."
