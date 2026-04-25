#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Create minimal config.json from environment variables if it doesn't exist yet.
# This replaces the interactive `paperclipai onboard` step for cloud deployments.
CONFIG_PATH="${PAPERCLIP_CONFIG:-/paperclip/instances/default/config.json}"
if [ ! -f "$CONFIG_PATH" ]; then
  echo "--- Creating Paperclip config at $CONFIG_PATH ---"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cat > "$CONFIG_PATH" <<EOF
{
  "\$meta": {
    "version": 1,
    "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "source": "onboard"
  },
  "database": {
    "mode": "postgres",
    "connectionString": "${DATABASE_URL}"
  },
  "logging": {
    "mode": "file"
  },
  "server": {
    "deploymentMode": "authenticated",
    "exposure": "private"
  },
  "auth": {},
  "telemetry": {},
  "storage": {},
  "secrets": {}
}
EOF
  chown -R node:node "${PAPERCLIP_HOME:-/paperclip}"
fi

# Generate first admin invite URL if no admin exists yet.
# Safe to run on every boot — skips silently once an admin account has been created.
# The invite URL will appear in logs on first boot.
echo "--- Paperclip bootstrap starting ---"
gosu node node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.js auth bootstrap-ceo 2>&1 || true
echo "--- Paperclip bootstrap complete ---"

trim() {
  # shellcheck disable=SC2001
  printf "%s" "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

read_database_url_from_env_file() {
  env_file="$1"
  [ -f "$env_file" ] || return 1

  raw_line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=' "$env_file" | tail -n 1 || true)
  [ -n "$raw_line" ] || return 1

  raw_value=${raw_line#*=}
  raw_value=$(trim "$raw_value")

  case "$raw_value" in
    "" )
      return 1
      ;;
    \#*)
      return 1
      ;;
    "*" )
      # Preserve quoted values exactly (including #), but strip wrapping quotes.
      raw_value=${raw_value#\"}
      raw_value=${raw_value%\"}
      ;;
    '*')
      raw_value=${raw_value#\'}
      raw_value=${raw_value%\'}
      ;;
    *)
      # For unquoted values, strip inline comments.
      # shellcheck disable=SC2001
      raw_value=$(printf "%s" "$raw_value" | sed -e 's/[[:space:]]\+#.*$//')
      ;;
  esac

  raw_value=$(trim "$raw_value")
  [ -n "$raw_value" ] || return 1

  printf "%s" "$raw_value"
}

CONFIG_PATH="${PAPERCLIP_CONFIG:-/paperclip/instances/default/config.json}"
CONFIG_DIR=$(dirname "$CONFIG_PATH")
ENV_PATH="${PAPERCLIP_ENV_PATH:-$CONFIG_DIR/.env}"
DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}"
DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"

DATABASE_URL_EFFECTIVE=$(trim "${DATABASE_URL:-}")
if [ -z "$DATABASE_URL_EFFECTIVE" ]; then
  DATABASE_URL_EFFECTIVE=$(read_database_url_from_env_file "$ENV_PATH" || true)
fi

mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_PATH" ]; then
  echo "--- Creating Paperclip config at $CONFIG_PATH ---"
  printf '{}\n' > "$CONFIG_PATH"
fi

if ! jq empty "$CONFIG_PATH" >/dev/null 2>&1; then
  echo "Warning: Existing config at $CONFIG_PATH is invalid JSON. Recreating minimal config." >&2
  printf '{}\n' > "$CONFIG_PATH"
fi

UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP_CONFIG="${CONFIG_PATH}.tmp.$$"

if [ -n "$DATABASE_URL_EFFECTIVE" ]; then
  echo "--- Configuring database mode: postgres (DATABASE_URL found) ---"
  jq \
    --arg updatedAt "$UPDATED_AT" \
    --arg deploymentMode "$DEPLOYMENT_MODE" \
    --arg deploymentExposure "$DEPLOYMENT_EXPOSURE" \
    --arg databaseUrl "$DATABASE_URL_EFFECTIVE" \
    '
      . = (if type == "object" then . else {} end) |
      ."$meta" = ((."$meta" // {}) + {"version": 1, "updatedAt": $updatedAt, "source": ((."$meta".source // "onboard"))}) |
      .database = (if (.database | type) == "object" then .database else {} end) |
      .database.mode = "postgres" |
      .database.connectionString = $databaseUrl |
      .logging = (if (.logging | type) == "object" then .logging else {} end) |
      .logging.mode = (.logging.mode // "file") |
      .server = (if (.server | type) == "object" then .server else {} end) |
      .server.deploymentMode = (.server.deploymentMode // $deploymentMode) |
      .server.exposure = (.server.exposure // $deploymentExposure) |
      .auth = (if (.auth | type) == "object" then .auth else {} end) |
      .telemetry = (if (.telemetry | type) == "object" then .telemetry else {} end) |
      .storage = (if (.storage | type) == "object" then .storage else {} end) |
      .secrets = (if (.secrets | type) == "object" then .secrets else {} end)
    ' "$CONFIG_PATH" > "$TMP_CONFIG"
else
  echo "--- Configuring database mode: embedded-postgres (no DATABASE_URL in env/.env) ---"
  jq \
    --arg updatedAt "$UPDATED_AT" \
    --arg deploymentMode "$DEPLOYMENT_MODE" \
    --arg deploymentExposure "$DEPLOYMENT_EXPOSURE" \
    '
      . = (if type == "object" then . else {} end) |
      ."$meta" = ((."$meta" // {}) + {"version": 1, "updatedAt": $updatedAt, "source": ((."$meta".source // "onboard"))}) |
      .database = (if (.database | type) == "object" then .database else {} end) |
      .database.mode = "embedded-postgres" |
      del(.database.connectionString) |
      .database.embeddedPostgresDataDir = (.database.embeddedPostgresDataDir // "/paperclip/instances/default/db") |
      .database.embeddedPostgresPort = (.database.embeddedPostgresPort // 54329) |
      .database.backup = (if (.database.backup | type) == "object" then .database.backup else {} end) |
      .database.backup.enabled = (.database.backup.enabled // true) |
      .database.backup.intervalMinutes = (.database.backup.intervalMinutes // 60) |
      .database.backup.retentionDays = (.database.backup.retentionDays // 7) |
      .database.backup.dir = (.database.backup.dir // "/paperclip/instances/default/data/backups") |
      .logging = (if (.logging | type) == "object" then .logging else {} end) |
      .logging.mode = (.logging.mode // "file") |
      .server = (if (.server | type) == "object" then .server else {} end) |
      .server.deploymentMode = (.server.deploymentMode // $deploymentMode) |
      .server.exposure = (.server.exposure // $deploymentExposure) |
      .auth = (if (.auth | type) == "object" then .auth else {} end) |
      .telemetry = (if (.telemetry | type) == "object" then .telemetry else {} end) |
      .storage = (if (.storage | type) == "object" then .storage else {} end) |
      .secrets = (if (.secrets | type) == "object" then .secrets else {} end)
    ' "$CONFIG_PATH" > "$TMP_CONFIG"
fi

mv "$TMP_CONFIG" "$CONFIG_PATH"
chown -R node:node "${PAPERCLIP_HOME:-/paperclip}"

# Generate first admin invite URL if no admin exists yet.
# Safe to run on every boot — skips silently once an admin account has been created.
# The invite URL will appear in logs on first boot.
echo "--- Paperclip bootstrap starting ---"
gosu node node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.js auth bootstrap-ceo 2>&1 || true
echo "--- Paperclip bootstrap complete ---"

exec gosu node "$@"

