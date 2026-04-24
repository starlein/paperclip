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

exec gosu node "$@"

