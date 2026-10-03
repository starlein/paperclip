#!/bin/sh
# Isolated proxy-only integration checks; no Compose, host ports, or live volumes.
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
image="paperclip-nginx-safety-test:local"
docker build -t "$image" "$root/docker/nginx"

docker run --rm --network none --add-host paperclip:127.0.0.1 \
  -e PAPERCLIP_TLS_SERVER_NAME=paperclip.example.com \
  --mount "type=bind,src=$root/docker/nginx/paperclip.conf.template,dst=/etc/nginx/templates/default.conf.template,readonly" \
  --entrypoint sh "$image" -ec '
    /docker-entrypoint.sh nginx -t
    nginx
    trap "nginx -s quit" EXIT
    headers=$(curl --silent --show-error --max-time 5 --dump-header - --output /dev/null \
      -H "Host: attacker.example" "http://127.0.0.1/probe?keep=1")
    printf "%s\n" "$headers"
    case "$headers" in
      *"Location: https://paperclip.example.com/probe?keep=1"*) ;;
      *) echo "FAIL: redirect did not use the canonical hostname" >&2; exit 1 ;;
    esac
    san=$(openssl x509 -in /etc/nginx/certs/fullchain.pem -noout -ext subjectAltName)
    case "$san" in
      *"DNS:paperclip.example.com"*) ;;
      *) echo "FAIL: hostname SAN fallback missing" >&2; exit 1 ;;
    esac
  '

docker run --rm --network none --entrypoint sh "$image" -ec '
  before=$(sha256sum /etc/nginx/conf.d/default.conf)
  export PAPERCLIP_TLS_SERVER_NAME="bad.example; return 302 https://attacker.example"
  if /docker-entrypoint.sh nginx -t; then
    echo "FAIL: invalid hostname was accepted" >&2
    exit 1
  fi
  test ! -e /etc/nginx/certs/fullchain.pem
  test ! -e /etc/nginx/certs/key.pem
  test "$before" = "$(sha256sum /etc/nginx/conf.d/default.conf)"
'

printf '%s\n' 'PASS: nginx entrypoint, config syntax, canonical redirect, SAN fallback, and invalid-host fail-closed checks'
