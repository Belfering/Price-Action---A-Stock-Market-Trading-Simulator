#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/price-action}"

echo "Listening sockets:"
ss -ltnp || true

echo
echo "Firewall:"
ufw status verbose || true

echo
echo "Docker:"
cd "${APP_DIR}"
docker compose ps

echo
echo "Local app health:"
curl -fsS http://127.0.0.1:8080 >/dev/null && echo "frontend proxy ok"
curl -fsS http://127.0.0.1:8080/api/health | head -c 500
echo
