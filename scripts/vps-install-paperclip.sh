#!/usr/bin/env bash
# Paperclip VPS install script — run on fresh Ubuntu after reformat
# Usage: bash vps-install-paperclip.sh
# Or: ssh root@64.176.199.162 'bash -s' < scripts/vps-install-paperclip.sh

set -euo pipefail

PAPERCLIP_DIR="${PAPERCLIP_DIR:-/opt/paperclip}"
PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
VPS_IP="${VPS_IP:-64.176.199.162}"

echo "==> Paperclip VPS Install"
echo "    Dir: $PAPERCLIP_DIR"
echo "    Port: $PAPERCLIP_PORT"
echo "    Public URL: http://${VPS_IP}:${PAPERCLIP_PORT}"
echo ""

# 1. Update system
echo "==> Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

# 2. Install Docker
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker..."
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME:-jammy}") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "==> Docker already installed"
fi

# 3. Clone or update Paperclip
if [ -d "$PAPERCLIP_DIR" ]; then
  echo "==> Updating existing Paperclip repo..."
  cd "$PAPERCLIP_DIR"
  git fetch origin && git reset --hard origin/master
else
  echo "==> Cloning Paperclip..."
  mkdir -p "$(dirname "$PAPERCLIP_DIR")"
  git clone https://github.com/paperclipai/paperclip.git "$PAPERCLIP_DIR"
  cd "$PAPERCLIP_DIR"
fi

# 4. Create .env
BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -base64 32)}"
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-http://${VPS_IP}:${PAPERCLIP_PORT}}"
PAPERCLIP_DATA_DIR="${PAPERCLIP_DATA_DIR:-${PAPERCLIP_DIR}/data}"

mkdir -p "$PAPERCLIP_DATA_DIR"

cat > "$PAPERCLIP_DIR/.env" << EOF
PAPERCLIP_PORT=${PAPERCLIP_PORT}
PAPERCLIP_DATA_DIR=${PAPERCLIP_DATA_DIR}
PAPERCLIP_PUBLIC_URL=${PAPERCLIP_PUBLIC_URL}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
EOF

echo "==> Created .env (BETTER_AUTH_SECRET generated)"

# 5. Patch Dockerfile if lockfile is out of sync (upstream drift)
if grep -q 'frozen-lockfile' "$PAPERCLIP_DIR/Dockerfile"; then
  sed -i 's/--frozen-lockfile/--no-frozen-lockfile/' "$PAPERCLIP_DIR/Dockerfile"
  echo "==> Patched Dockerfile for lockfile flexibility"
fi

# 6. Build and run
echo "==> Building and starting Paperclip..."
cd "$PAPERCLIP_DIR"
docker compose -f docker-compose.quickstart.yml up -d --build

# 7. Wait and verify
echo "==> Waiting for startup..."
sleep 20
if curl -sf "http://localhost:${PAPERCLIP_PORT}/api/health" > /dev/null; then
  echo ""
  echo "==> Paperclip is running!"
  echo "    URL: http://${VPS_IP}:${PAPERCLIP_PORT}"
  echo "    Health: $(curl -s "http://localhost:${PAPERCLIP_PORT}/api/health")"
else
  echo "==> Startup may still be in progress. Check logs:"
  echo "    docker compose -f $PAPERCLIP_DIR/docker-compose.quickstart.yml logs -f"
  exit 1
fi
