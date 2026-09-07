#!/bin/sh
set -eu

cert_dir=/etc/nginx/certs
cert_file="$cert_dir/fullchain.pem"
key_file="$cert_dir/key.pem"

if [ -e "$cert_file" ] || [ -e "$key_file" ]; then
  if [ -s "$cert_file" ] && [ -s "$key_file" ]; then
    exit 0
  fi
  echo "Both $cert_file and $key_file must be present and non-empty" >&2
  exit 1
fi

server_name="${PAPERCLIP_TLS_SERVER_NAME:-localhost}"
alt_names="${PAPERCLIP_TLS_CERT_ALT_NAMES:-}"
if [ -z "$alt_names" ]; then
  if [ "$server_name" = "localhost" ]; then
    alt_names="DNS:localhost,IP:127.0.0.1"
  else
    alt_names="DNS:${server_name},DNS:localhost,IP:127.0.0.1"
  fi
fi

mkdir -p "$cert_dir"
umask 077
openssl req -x509 -newkey rsa:2048 -sha256 \
  -days "${PAPERCLIP_TLS_CERT_DAYS:-3650}" \
  -nodes \
  -keyout "$key_file.tmp" \
  -out "$cert_file.tmp" \
  -subj "/CN=${server_name}" \
  -addext "subjectAltName=${alt_names}"
mv "$key_file.tmp" "$key_file"
mv "$cert_file.tmp" "$cert_file"
