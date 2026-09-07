FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

RUN apk add --no-cache openssl

COPY docker-entrypoint.d/10-generate-selfsigned-cert.sh /docker-entrypoint.d/10-generate-selfsigned-cert.sh
COPY paperclip.conf.template /etc/nginx/templates/default.conf.template
RUN chmod +x /docker-entrypoint.d/10-generate-selfsigned-cert.sh
