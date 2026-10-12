# Docker Quickstart

Run Paperclip in Docker without installing Node or pnpm locally.

All commands below assume you are in the **project root** (the directory containing `package.json`), not inside `docker/`.

## Building the image

```sh
docker build --target production -t paperclip-local .
```

The Dockerfile installs common agent tools (`git`, `gh`, `curl`, `wget`, `ripgrep`, `python3`), runs the app under `tini` as PID 1 for signal handling/zombie reaping, and installs the Claude, Codex, and OpenCode CLIs.

Build arguments:

| Arg | Default | Purpose |
|-----|---------|---------|
| `USER_UID` | `1000` | UID for the container `node` user (match your host UID to avoid permission issues on bind mounts) |
| `USER_GID` | `1000` | GID for the container `node` group |
| `CLI_TOOLS_CACHE_EPOCH` | empty | Refresh the CLI-install layer; CI supplies the current ISO week |
| `PAPERCLIP_BUILD_VERSION` | empty | Runtime version when Git metadata is unavailable |
| `PAPERCLIP_BUILD_COMMIT` | empty | Source commit written into the server build stamp and runtime environment |

Changing the build version or commit preserves the CLI-install cache. The
tool layer refreshes when its weekly epoch, base image, installation command,
or earlier build inputs change. Local builds can set a new epoch explicitly
to refresh tools without clearing the entire build cache.

```sh
docker build --target production -t paperclip-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

## Standard images and downstream composition

The Docker workflow publishes the standard `production` target for Linux AMD64
and ARM64. Canonical master pushes also publish
`ghcr.io/paperclipai/paperclip:sha-<FULL_SHA>` and a GitHub/Sigstore attestation
for its immutable multi-platform digest. Downstream services can compose their
own images from this public base without rebuilding Core.

Stamped standard images include the build-owned remote provider pack at
`/opt/paperclip-runner/provider-pack` and set
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` to that directory. Downstream
compositions and the explicit `cloud` target inherit both. The pack is required
on the controller for remote OpenCode and ACPX runs, even when the sandbox has
preinstalled providers; setting the environment variable alone cannot repair an
image that omits the pack. Rebuild and redeploy from a standard image containing
the pack if runs fail with `runner_remote_provider_artifact_incompatible`.

Local Docker builds must supply a full `PAPERCLIP_BUILD_COMMIT` to include a
qualified pack. Unstamped builds remain usable for local adapters and skip pack
generation. The pack stays root-owned and readable by remapped runtime UIDs.

The legacy recurring public `-cloud` publisher is retired. Master pushes,
release tags, and manual `Docker` dispatches no longer build that variant.
Existing `-cloud` tags and digests remain in the registry for rollback; their
release-channel aliases no longer advance. This change deletes no images,
cache tags, or migrator artifacts.

The `cloud` Dockerfile target remains available for explicit
[preview builds](preview-release-artifacts.md). Those requests still publish a
full-SHA `-cloud` tag when needed. They do not advance a release channel or
replace downstream private composition.

A published image alone does not prove source tests or migration compatibility.
Downstream deployment tooling must verify [source proof](cloud-build-readiness.md),
the standard image attestation, the exact-source migrator, and its own composed
image before rollout. Resolve immutable digests instead of deploying mutable tags.

## One-liner (build + run)

```sh
docker build --target production -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -e PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Open: `http://localhost:3100`

Data persistence:

- Embedded PostgreSQL data
- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-paperclip` in the example above).

## Docker Compose

### Quickstart (embedded SQLite)

Single container, no external database. Data persists via a bind mount.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-paperclip`

Optional overrides:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

If you change host port or use a non-local domain, set `PAPERCLIP_PUBLIC_URL` to the external URL you will use in browser/auth flows.

Pass `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` to enable local adapter runs.

### Root Compose stack (embedded PostgreSQL by default)

The root Compose stack starts Paperclip with its embedded PostgreSQL by default.
It also starts Redis. The nginx TLS proxy is optional and stays disabled unless
the `proxy` profile is enabled.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker-compose.yml up --build
```

Paperclip data, including the embedded PostgreSQL cluster, defaults to
`./data/docker-paperclip`.

To use the separate PostgreSQL 17 service instead, configure `.env` and enable
its Compose profile:

```dotenv
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgres://paperclip:***@postgres:5432/paperclip
POSTGRES_DATA_DIR=postgres-data
COMPOSE_PROFILES=${POSTGRES_PASSWORD:+postgres}
```

The PostgreSQL service is health-checked before Paperclip starts. Its data
source defaults to the Docker named volume `postgres-data`; set
`POSTGRES_DATA_DIR` to an absolute host path when host-managed storage is
preferred. Changing this setting selects a different, initially empty database
location; existing data is not migrated automatically. The `postgres:17-alpine`
service mounts this data source at `/var/lib/postgresql/data` and stores the
cluster directly there (not in a major-version subdirectory).

When `DATABASE_URL` points to a remote PostgreSQL server, set only
`DATABASE_URL` and leave `POSTGRES_PASSWORD` unset. The profile expression then
stays empty and Compose does not build, create, or start the local PostgreSQL
service. You can always enable it explicitly with
`docker compose --profile postgres up`.

The root `docker-compose.yml` also includes an optional nginx TLS proxy. When
enabled, it generates a self-signed certificate for `PAPERCLIP_TLS_SERVER_NAME`
(default `localhost`) into the
`proxy-certs` Docker volume, publishes the Paperclip port only on
`127.0.0.1:${PAPERCLIP_PORT:-3100}`, and publishes proxy ports `80` and `443`.
The Paperclip container also resolves `host.docker.internal` through Docker's
host gateway. Host-specific domains and real certificate mounts belong in
ignored local override files such as `docker-compose.override.yml`, not in
tracked git files.

Put hostnames and public URL values in `.env`:

```dotenv
PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.example.com
PAPERCLIP_TLS_SERVER_NAME=paperclip.example.com
PAPERCLIP_TLS_CERT_ALT_NAMES=DNS:paperclip.example.com,DNS:localhost,IP:127.0.0.1
# Keep this line after POSTGRES_PASSWORD and PAPERCLIP_TLS_SERVER_NAME.
COMPOSE_PROFILES=${POSTGRES_PASSWORD:+postgres}${PAPERCLIP_TLS_SERVER_NAME:+${POSTGRES_PASSWORD:+,}proxy}
```

This expression independently enables PostgreSQL when `POSTGRES_PASSWORD` is
set and the proxy when `PAPERCLIP_TLS_SERVER_NAME` is set. You can always enable
the proxy explicitly with `docker compose --profile proxy up`. Without its
profile, Compose does not build, create, or start the proxy service.

`PAPERCLIP_TLS_SERVER_NAME` must be a DNS hostname, without a scheme, port,
path, wildcard, or nginx variables. The proxy validates it before startup and
renders it into the HTTP-to-HTTPS redirect; request Host headers cannot choose
the redirect destination. The configuration is mounted as
`/etc/nginx/templates/default.conf.template`, and only this hostname variable
is substituted, leaving nginx runtime variables intact.

Leave `PAPERCLIP_TLS_CERT_ALT_NAMES` unset or empty to include the configured
hostname plus `localhost` and `127.0.0.1` in a generated certificate. Both
certificate files must be absent before generation occurs. An existing
non-empty pair is reused unchanged; a partial or empty pair fails startup
without modifying the files. Repair such a pair explicitly rather than
expecting the proxy to overwrite mounted certificates.

For a real certificate, keep only the host-specific bind mounts in a local
override similar to this:

```yaml
services:
  paperclip:
    group_add:
      - "${DOCKER_GID:-992}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
  proxy:
    volumes:
      - /path/to/fullchain.pem:/etc/nginx/certs/fullchain.pem:ro
      - /path/to/key.pem:/etc/nginx/certs/key.pem:ro
```

`group_add`, Docker socket mounts, and certificate bind mounts are Compose
structure and cannot be added by `.env` alone. Keep them in the ignored local
override. The values referenced by the tracked Compose file, including
`DOCKER_GID`, public hostnames, and TLS names, belong in `.env`.

### Untrusted PR review

Isolated container for reviewing untrusted pull requests with Codex or Claude, without exposing your host machine. See `doc/UNTRUSTED-PR-REVIEW.md` for the full workflow.

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let Paperclip derive auth/callback defaults:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

For fresh `authenticated/private` Docker or appliance-style installs, the first
admin can now be claimed entirely from the browser after sign-in. Open the
Paperclip URL, sign in or create an account, then choose `Claim this instance`
on the setup screen. This browser claim is disabled for `authenticated/public`;
public deployments should run the high-entropy CLI invite fallback instead:

```sh
pnpm paperclipai auth bootstrap-ceo
```

Granular overrides remain available if needed (`PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `PAPERCLIP_ALLOWED_HOSTNAMES`).

Set `PAPERCLIP_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

### Optional Vercel Connect credentials

Vercel Connect's backend integration is retained for controlled testing and
existing Vercel-backed connections, but its new-connection UI is currently
withheld from **Apps → Browse**. Setting
`PAPERCLIP_VERCEL_CONNECT_ENABLED=true` does not expose a customer-facing setup
entry. Native provider setup screens remain unchanged. Vercel-hosted deployments use the
workload OIDC token Vercel injects. Other hosted and self-hosted deployments
can provide `PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN` as a deployment bootstrap
secret only when that token type is accepted by the live Connect API:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_VERCEL_CONNECT_ENABLED: "true"
      PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN: ${PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN}
```

Do not save that access token in a company secret or connection config. It is
instance bootstrap authority for the operator-selected Vercel account. A token's
long expiry and broad Vercel scope do not prove Connect compatibility; validate
it with connector metadata before rollout. Workload OIDC takes precedence when
both authorities are present. Turning the feature flag off hides new
Vercel-backed setup; existing connections keep resolving while workload OIDC or
the bootstrap token remains available. Missing or invalid authority fails
closed. See the [Vercel Connect operator guide](./connections/VERCEL-CONNECT.md).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

If you want local adapter runs inside the container, pass API keys when starting the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Notes:

- Without API keys, the app still runs normally.
- Adapter environment checks in Paperclip will surface missing auth/CLI prerequisites.
- The image installs the system `bubblewrap` package without granting the `node`
  user sudo access to application-owned executables. Sandboxed runs still fail
  closed if the host does not permit the required namespaces; do not work around
  this by authorizing binaries under writable `/app` paths in sudoers.

### Docker safety regression checks

From the repository root, with Node.js, OpenSSL, and `envsubst` installed:

```sh
node --test scripts/tests/docker-safety.test.mjs
```

For the official nginx entrypoint, configuration syntax, and hostile Host-header
redirect check, with Docker available:

```sh
sh scripts/tests/docker-nginx-safety.sh
```

The latter builds only the small proxy image and uses disposable containers
without host ports, deployment volumes, `.env`, or local Compose overrides.

## Podman Quadlet (systemd)

The `docker/quadlet/` directory contains unit files to run Paperclip + PostgreSQL as systemd services via Podman Quadlet.

| File | Purpose |
|------|---------|
| `docker/quadlet/paperclip.pod` | Pod definition — groups containers into a shared network namespace |
| `docker/quadlet/paperclip.container` | Paperclip server — joins the pod, connects to Postgres at `127.0.0.1` |
| `docker/quadlet/paperclip-db.container` | PostgreSQL 17 — joins the pod, health-checked |

### Setup

1. Build the image (see above).

2. Copy quadlet files to your systemd directory:

   ```sh
   # Rootless (recommended)
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # Or rootful
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. Create a secrets env file (keep out of version control):

   ```sh
   cat > ~/.config/containers/systemd/paperclip.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=paperclip
   POSTGRES_PASSWORD=paperclip
   POSTGRES_DB=paperclip
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip
   # OPENAI_API_KEY=sk-...
   # ANTHROPIC_API_KEY=sk-...
   EOL
   ```

4. Create the data directory and start:

   ```sh
   mkdir -p ~/.local/share/paperclip
   systemctl --user daemon-reload
   systemctl --user start paperclip-pod
   ```

### Quadlet management

```sh
journalctl --user -u paperclip -f        # App logs
journalctl --user -u paperclip-db -f     # DB logs
systemctl --user status paperclip-pod    # Pod status
systemctl --user restart paperclip-pod   # Restart all
systemctl --user stop paperclip-pod      # Stop all
```

### Quadlet notes

- **First boot**: Unlike Docker Compose's `condition: service_healthy`, Quadlet's `After=` only waits for the DB unit to *start*, not for PostgreSQL to be ready. On a cold first boot you may see one or two restart attempts in `journalctl --user -u paperclip` while PostgreSQL initialises — this is expected and resolves automatically via `Restart=on-failure`.
- Containers in a pod share `localhost`, so Paperclip reaches Postgres at `127.0.0.1:5432`.
- PostgreSQL data persists in the `paperclip-pgdata` named volume.
- Paperclip data persists at `~/.local/share/paperclip`.
- For rootful quadlet deployment, remove `%h` prefixes and use absolute paths.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `npx paperclipai onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/paperclip-smoke.env PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local Paperclip on `3100`.
- Smoke script also defaults `PAPERCLIP_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `paperclipai auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- Set `SMOKE_DETACH=true` to leave the container running for automation and optionally write shell-ready metadata to `SMOKE_METADATA_FILE`.
- Set `SMOKE_CONTAINER_NAME` to fix the container's name up front. Automation that has to collect diagnostics when the script *fails* needs a name it already knows, rather than one it can only read back out of a successful run. Defaults to the image name.
- The container's logs are dumped to `SMOKE_LOG_FILE` (default `$TMPDIR/<container name>.log`) before the script tears the container down, so a run that never became ready still leaves its logs behind.
- The image definition is in `docker/Dockerfile.onboard-smoke`.

## General Notes

- The `docker-entrypoint.sh` adjusts the container `node` user UID/GID at startup to match the values passed via `USER_UID`/`USER_GID`, avoiding permission issues on bind-mounted volumes.
- Paperclip data persists via Docker volumes/bind mounts (compose) or at `~/.local/share/paperclip` (quadlet).

## Native Runner build cache

The image compiles the native Runner in `runner-build`, before copying the
application source. A pinned `cargo-chef` generates a dependency recipe in
`runner-plan`. The separate `runner-deps` stage compiles that recipe with the
package-owned Rust compiler. Both the dependency build and the real binary use
the release profile and locked Cargo dependencies. The recipe stage never
modifies source in the checkout.

Changes to Rust source or embedded protocol inputs rebuild the real binary but
can reuse compiled dependencies when the recipe is unchanged. Dependency
manifests, the Cargo lockfile, target metadata, or compiler changes invalidate
the relevant cache. Ordinary server or UI changes can reuse the entire native
build through the existing registry cache (`mode=max`). Each platform gets its
own native build; no cross-architecture binary is reused. No additional GitHub
Actions cache is created. A cold build also installs the recipe generator and
compiles dependencies, so the savings apply after those layers are available.

Cloud builds import one registry cache: the first available full-SHA cache in
the current commit's ten-entry first-parent ancestry, with the legacy cache
as a final fallback. Each build still exports its own SHA cache with
`mode=max`. In fresh-builder checks, importing several historical manifests
missed native layers that a single matching manifest reused. The selector
inspects metadata after Docker login, stops at the first available cache, and
permits a cold build if no cache can be read.

The application build inherits that stage and still runs the normal server
build, including Cargo, binary staging, and generated-contract checks. Rust
input file times are normalized in both stages so fresh checkouts do not force
Cargo to rebuild unchanged source. Changes made by build scripts still reach
Cargo's normal validation. The final application copy excludes Cargo's target
directory as before. Cache misses only cost compilation time.

Pull requests that change the Dockerfile, Docker ignore rules, or Runner native
inputs also build the isolated `runner-build` target in `Docker Runner check`.
The check runs `bash scripts/check-docker-runner-cache.sh` against a disposable
copy of tracked source and the actual Docker ignore rules. It compiles a baseline
and exports a local cache, removes that builder, changes a Rust metadata constant,
and rebuilds on a fresh builder using only the exported cache. It requires a
cached dependency build, an unchanged dependency recipe, and changed metadata
from the real binary. It also verifies that a dependency declaration change
alters the recipe. The probe exports small metadata results instead of importing
a large test image into the Docker daemon. Temporary builders and cache files
are removed afterward. It catches missing embedded inputs before the post-merge
build. It uses a GitHub-hosted runner with read-only repository access and never
publishes images or registry caches. Allow up to 20 minutes for its cold build and
source rebuild.
