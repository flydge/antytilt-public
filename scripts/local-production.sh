#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$project_dir/.env.local-production"
htpasswd_file="$project_dir/.beta-htpasswd"

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  compose=(docker compose)
fi
compose+=(--env-file "$env_file" --project-directory "$project_dir" -f "$project_dir/compose.yaml")

usage() {
  printf '%s\n' \
    'Usage: ./scripts/local-production.sh <command>' \
    '' \
    'Commands:' \
    '  init          create the ignored local secrets file' \
    '  start         build and start API, RM worker, PostgreSQL and Redis' \
    '  stop          stop application containers without deleting data' \
    '  restart       restart the application stack' \
    '  status        show containers and API/RM health' \
    '  logs          follow API and RM-worker logs' \
    '  tunnel        start a temporary public HTTPS Cloudflare URL' \
    '  tunnel-url    print the temporary public HTTPS URL' \
    '  tunnel-stop   stop the temporary tunnel' \
    '  access        print the access gateway login' \
    '  named-tunnel  start the configured permanent Cloudflare Tunnel' \
    '  import-legacy import the existing native PostgreSQL database once' \
    '  backup        create an encrypted-credential-compatible PostgreSQL dump' \
    '  keep-awake    prevent macOS sleep while the stack is running'
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo 'Docker is not installed. Install Docker Desktop or Colima first.' >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo 'The Docker engine is not running. Start Docker Desktop or run: colima start' >&2
    exit 1
  fi
}

initialize() {
  if [[ -f "$env_file" ]]; then
    echo "$env_file already exists; leaving its secrets unchanged."
  else
    umask 077
    {
      echo 'APP_PORT=8787'
      printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
      printf 'CREDENTIALS_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')"
      echo 'CLOUDFLARE_TUNNEL_TOKEN='
    } > "$env_file"
    chmod 600 "$env_file"
    echo "Created $env_file with local-only random secrets."
  fi
  initialize_access
}

initialize_access() {
  local username password password_hash
  username="$(sed -n 's/^BETA_ACCESS_USERNAME=//p' "$env_file" | tail -1)"
  password="$(sed -n 's/^BETA_ACCESS_PASSWORD=//p' "$env_file" | tail -1)"
  username="${username:-antytilt-beta}"
  password="${password:-$(openssl rand -hex 12)}"
  if ! grep -q '^BETA_ACCESS_USERNAME=' "$env_file"; then
    printf 'BETA_ACCESS_USERNAME=%s\n' "$username" >> "$env_file"
  fi
  if ! grep -q '^BETA_ACCESS_PASSWORD=' "$env_file"; then
    printf 'BETA_ACCESS_PASSWORD=%s\n' "$password" >> "$env_file"
  fi
  password_hash="$(openssl passwd -apr1 "$password")"
  umask 077
  printf '%s:%s\n' "$username" "$password_hash" > "$htpasswd_file"
  chmod 600 "$htpasswd_file"
}

ensure_initialized() {
  if [[ ! -f "$env_file" ]]; then
    initialize
  elif [[ ! -f "$htpasswd_file" ]]; then
    initialize_access
  fi
}

show_access() {
  local username password
  username="$(sed -n 's/^BETA_ACCESS_USERNAME=//p' "$env_file" | tail -1)"
  password="$(sed -n 's/^BETA_ACCESS_PASSWORD=//p' "$env_file" | tail -1)"
  printf 'Gateway username: %s\nGateway password: %s\n' "$username" "$password"
}

health() {
  local port
  port="$(awk -F= '$1 == "APP_PORT" { print $2 }' "$env_file" | tail -1)"
  port="${port:-8787}"
  printf '\nAPI readiness:\n'
  curl --fail --silent --show-error "http://127.0.0.1:${port}/api/health/ready" || return 1
  printf '\n\nRM worker:\n'
  curl --fail --silent --show-error "http://127.0.0.1:${port}/api/health/worker" || return 1
  printf '\n'
}

wait_for_health() {
  local attempt health_output
  for attempt in {1..60}; do
    if health_output="$(health 2>&1)"; then
      printf '%s\n' "$health_output"
      return
    fi
    sleep 2
  done
  echo 'The stack did not become healthy within 120 seconds.' >&2
  "${compose[@]}" ps >&2
  "${compose[@]}" logs --tail=100 api worker >&2
  exit 1
}

command_name="${1:-}"
case "$command_name" in
  init)
    initialize
    ;;
  start)
    require_docker
    ensure_initialized
    "${compose[@]}" up -d --build postgres redis api worker
    "${compose[@]}" ps
    wait_for_health
    ;;
  stop)
    require_docker
    ensure_initialized
    "${compose[@]}" stop quick-tunnel tunnel worker api redis postgres 2>/dev/null || \
      "${compose[@]}" stop worker api redis postgres
    ;;
  restart)
    require_docker
    ensure_initialized
    "${compose[@]}" restart postgres redis api worker
    "${compose[@]}" ps
    wait_for_health
    ;;
  status)
    require_docker
    ensure_initialized
    "${compose[@]}" ps
    health
    ;;
  logs)
    require_docker
    ensure_initialized
    "${compose[@]}" logs --tail=200 --follow api worker
    ;;
  tunnel)
    require_docker
    ensure_initialized
    "${compose[@]}" --profile quick-tunnel up -d quick-tunnel
    echo 'Waiting for Cloudflare to assign an HTTPS URL...'
    for _ in {1..30}; do
      url="$("${compose[@]}" logs quick-tunnel 2>/dev/null | sed -nE 's#.*(https://[a-zA-Z0-9-]+\.trycloudflare\.com).*#\1#p' | tail -1)"
      if [[ -n "$url" ]]; then
        echo "Public test URL: $url"
        show_access
        exit 0
      fi
      sleep 1
    done
    echo 'Tunnel started, but the URL was not detected yet. Run tunnel-url in a few seconds.'
    ;;
  tunnel-url)
    require_docker
    ensure_initialized
    "${compose[@]}" logs quick-tunnel 2>/dev/null | sed -nE 's#.*(https://[a-zA-Z0-9-]+\.trycloudflare\.com).*#\1#p' | tail -1
    ;;
  tunnel-stop)
    require_docker
    ensure_initialized
    "${compose[@]}" --profile quick-tunnel stop quick-tunnel
    ;;
  access)
    ensure_initialized
    show_access
    ;;
  named-tunnel)
    require_docker
    ensure_initialized
    if ! grep -Eq '^CLOUDFLARE_TUNNEL_TOKEN=.+$' "$env_file"; then
      echo 'Set CLOUDFLARE_TUNNEL_TOKEN in .env.local-production first.' >&2
      exit 1
    fi
    "${compose[@]}" --profile tunnel up -d tunnel
    ;;
  import-legacy)
    require_docker
    ensure_initialized
    legacy_env="$project_dir/.env"
    legacy_key_file="$project_dir/data/.credential-key"
    if [[ ! -f "$legacy_env" || ! -f "$legacy_key_file" ]]; then
      echo 'Legacy .env or data/.credential-key is missing; import cannot preserve encrypted credentials.' >&2
      exit 1
    fi
    legacy_url="$(sed -n 's/^DATABASE_URL=//p' "$legacy_env" | tail -1)"
    if [[ -z "$legacy_url" ]]; then
      echo 'DATABASE_URL is missing from the legacy .env.' >&2
      exit 1
    fi
    target_users="$("${compose[@]}" exec -T postgres psql -U antytilt -d antytilt -Atc 'SELECT count(*) FROM users')"
    if [[ "$target_users" != "0" ]]; then
      echo "Refusing import: the container database already has $target_users user(s)." >&2
      exit 1
    fi
    legacy_users="$(psql "$legacy_url" -Atc 'SELECT count(*) FROM users')"
    if [[ "$legacy_users" == "0" ]]; then
      echo 'Refusing import: the legacy database has no users.' >&2
      exit 1
    fi
    backup_dir="$project_dir/backups"
    mkdir -p "$backup_dir"
    backup_path="$backup_dir/legacy-antytilt-$(date +%Y%m%d-%H%M%S).dump"
    pg_dump "$legacy_url" --format=custom --no-owner > "$backup_path"
    chmod 600 "$backup_path"

    legacy_key="$(tr -d '\r\n' < "$legacy_key_file")"
    if [[ "$(printf '%s' "$legacy_key" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')" != "32" ]]; then
      echo 'The legacy credential key is invalid; database backup was retained but nothing was imported.' >&2
      exit 1
    fi
    temporary_env="$(mktemp "$project_dir/.env.local-production.XXXXXX")"
    awk -v key="$legacy_key" '
      BEGIN { replaced = 0 }
      /^CREDENTIALS_ENCRYPTION_KEY=/ { print "CREDENTIALS_ENCRYPTION_KEY=" key; replaced = 1; next }
      { print }
      END { if (!replaced) print "CREDENTIALS_ENCRYPTION_KEY=" key }
    ' "$env_file" > "$temporary_env"
    chmod 600 "$temporary_env"
    mv "$temporary_env" "$env_file"

    "${compose[@]}" stop worker api
    "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U antytilt -d antytilt \
      -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
    "${compose[@]}" exec -T postgres pg_restore --exit-on-error --no-owner -U antytilt -d antytilt < "$backup_path"
    "${compose[@]}" up -d --force-recreate api worker
    wait_for_health
    echo "Imported $legacy_users users from the legacy database."
    echo "Safety backup: $backup_path"
    ;;
  backup)
    require_docker
    ensure_initialized
    backup_dir="$project_dir/backups"
    mkdir -p "$backup_dir"
    backup_path="$backup_dir/antytilt-$(date +%Y%m%d-%H%M%S).dump"
    "${compose[@]}" exec -T postgres pg_dump --format=custom --no-owner --username=antytilt --dbname=antytilt > "$backup_path"
    chmod 600 "$backup_path"
    echo "Created $backup_path"
    echo "Keep .env.local-production with this dump; its encryption key is required to read saved exchange credentials."
    ;;
  keep-awake)
    require_docker
    ensure_initialized
    echo 'Keeping this Mac awake. Leave this command running; press Ctrl+C to stop.'
    caffeinate -dimsu "${compose[@]}" logs --follow --tail=20 api worker
    ;;
  *)
    usage
    exit 1
    ;;
esac
