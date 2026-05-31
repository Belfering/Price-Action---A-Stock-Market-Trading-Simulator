#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:-}"

if [[ -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
  echo "Usage: $0 backups/profile_YYYYmmdd_HHMMSS.sql.gz" >&2
  exit 1
fi

docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" --if-exists && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
gunzip -c "${BACKUP_FILE}" | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
