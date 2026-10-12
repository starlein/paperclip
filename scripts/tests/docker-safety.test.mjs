import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'paperclip-docker-safety-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function generate(dir, env = {}) {
  return spawnSync('sh', [`${root}docker/nginx/docker-entrypoint.d/10-generate-selfsigned-cert.sh`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PAPERCLIP_TLS_CERT_DIR: dir, ...env },
  });
}

test('image installs ordinary bubblewrap without a privileged application-owned executable', () => {
  const dockerfile = read('Dockerfile');
  assert.equal(existsSync(`${root}scripts/paperclip-bwrap`), false);
  assert.doesNotMatch(dockerfile, /sudoers\.d\/paperclip-bwrap|COPY[^\n]*scripts\/paperclip-bwrap/);
  assert.match(dockerfile, /apt-get install[^\n]*\bbubblewrap\b/);
});

test('partial or empty TLS pairs fail without any filesystem changes', (t) => {
  for (const cert of [null, '', 'existing-cert']) {
    for (const key of [null, '', 'existing-key']) {
      if ((cert === null && key === null) || (cert && key)) continue;
      const dir = fixture(t);
      if (cert !== null) writeFileSync(join(dir, 'fullchain.pem'), cert);
      if (key !== null) writeFileSync(join(dir, 'key.pem'), key);
      const snapshot = () => readdirSync(dir).sort().map((name) => ({
        name, text: readFileSync(join(dir, name), 'utf8'), mtime: statSync(join(dir, name)).mtimeMs,
      }));
      const before = snapshot();
      const result = generate(dir);
      assert.notEqual(result.status, 0, `must reject cert=${JSON.stringify(cert)} key=${JSON.stringify(key)}`);
      assert.match(result.stderr, /partial|empty/i);
      assert.deepEqual(snapshot(), before);
    }
  }
});

test('absent TLS pair is generated with hostname SAN fallback and reused unchanged', (t) => {
  const dir = join(fixture(t), 'new-certs');
  const result = generate(dir, { PAPERCLIP_TLS_SERVER_NAME: 'paperclip.example.com', PAPERCLIP_TLS_CERT_ALT_NAMES: '' });
  assert.equal(result.status, 0, result.stderr);
  const certPath = join(dir, 'fullchain.pem');
  const keyPath = join(dir, 'key.pem');
  const inspect = spawnSync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /DNS:paperclip\.example\.com/);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  const before = [readFileSync(certPath), readFileSync(keyPath), statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs];
  assert.equal(generate(dir).status, 0);
  assert.deepEqual([readFileSync(certPath), readFileSync(keyPath), statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs], before);
});

test('partial custom paths and dangling certificate links fail before creating directories', (t) => {
  const dir = fixture(t);
  const certPath = join(dir, 'fullchain.pem');
  symlinkSync('missing-mounted-certificate', certPath);
  const missingDir = join(dir, 'must-not-be-created');
  const result = generate(missingDir, { PAPERCLIP_TLS_CERT_FILE: certPath });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /partial|empty/i);
  assert.equal(existsSync(missingDir), false);
  assert.equal(readlinkSync(certPath), 'missing-mounted-certificate');
  assert.deepEqual(readdirSync(dir), ['fullchain.pem']);
});

test('nginx renders only a validated canonical hostname, retaining nginx runtime variables', () => {
  const validator = `${root}docker/nginx/docker-entrypoint.d/05-validate-server-name.envsh`;
  const template = `${root}docker/nginx/paperclip.conf.template`;
  assert.ok(existsSync(validator), 'entrypoint must validate before rendering');
  assert.ok(existsSync(template), 'nginx configuration must be a template');
  const render = (hostname) => spawnSync('sh', ['-ec', '. "$1"; envsubst \'${PAPERCLIP_TLS_SERVER_NAME}\' < "$2"', 'sh', validator, template], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...(hostname === undefined ? {} : { PAPERCLIP_TLS_SERVER_NAME: hostname }) },
  });
  for (const hostname of ['paperclip.example.com', 'localhost', 'my-host.example', undefined]) {
    const result = render(hostname);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`return 301 https://${hostname ?? 'localhost'}$request_uri;`));
    for (const variable of ['$http_upgrade', '$connection_upgrade', '$host', '$remote_addr', '$proxy_add_x_forwarded_for']) {
      assert.ok(result.stdout.includes(variable), `must preserve ${variable}`);
    }
    assert.doesNotMatch(result.stdout, /https:\/\/\$host/);
  }
  for (const hostname of ['', 'evil.example; return 302 https://attacker.test', '$host', 'https://example.com', 'a/b', 'a b', 'a\nb', '*.example.com', '-bad.example', 'bad-.example', '.example', 'a..b', 'a'.repeat(64) + '.example', 'a.'.repeat(127) + 'b']) {
    const result = render(hostname);
    assert.notEqual(result.status, 0, `must reject ${JSON.stringify(hostname)}`);
    assert.equal(result.stdout, '', 'invalid hostname must fail before rendering');
    assert.match(result.stderr, /PAPERCLIP_TLS_SERVER_NAME/);
  }
});

test('root Compose mounts the template, allows SAN fallback, and preserves the release image', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /\.\/docker\/nginx\/paperclip\.conf\.template:\/etc\/nginx\/templates\/default\.conf\.template:ro/);
  assert.match(compose, /PAPERCLIP_TLS_CERT_ALT_NAMES: "\$\{PAPERCLIP_TLS_CERT_ALT_NAMES:-\}"/);
  assert.match(compose, /NGINX_ENVSUBST_FILTER: "\^PAPERCLIP_TLS_SERVER_NAME\$"/);
  assert.match(compose, /image: ghcr\.io\/starlein\/paperclip:v2026\.1012\.0/);
});

test('Docker documentation matches the root Compose path and PostgreSQL 17 storage', () => {
  const doc = read('doc/DOCKER.md');
  assert.match(doc, /docker compose -f docker-compose\.yml up --build/);
  assert.doesNotMatch(doc, /docker compose -f docker\/docker-compose\.yml/);
  assert.match(doc, /separate PostgreSQL 17 service/);
  assert.match(doc, /`postgres:17-alpine`[\s\S]*?`\/var\/lib\/postgresql\/data`[\s\S]*?cluster directly there/);
  assert.match(read('docker-compose.yml'), /image: postgres:17-alpine/);
  assert.match(read('docker-compose.yml'), /\$\{POSTGRES_DATA_DIR:-postgres-data\}:\/var\/lib\/postgresql\/data/);
});
