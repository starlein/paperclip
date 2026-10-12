FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY docker-entrypoint.d/ /docker-entrypoint.d/
COPY paperclip.conf.template /etc/nginx/templates/default.conf.template
RUN chmod +x /docker-entrypoint.d/05-validate-server-name.envsh /docker-entrypoint.d/10-generate-selfsigned-cert.sh
