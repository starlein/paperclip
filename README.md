# Paperclip Docker Release: v2026.403.1-stable

**Image:** `ghcr.io/starlein/paperclip:v2026.403.1-stable`

This README is for the `v2026.403.1-stable` Docker image built from the current branch head.

## What is included in this release

The image includes the Docker and template-related patches from your recent commits:

- `2a97d155` — **Docker helpers**
  - Adds `data/docker/.bashrc` with `paperclipai` alias for container shell usage.
  - Adds `data/docker/bin/xdg-open` helper script.
- `9f3ac37b` and `b4acba70` — **Company startup template work**
  - Introduces `companies/paperclip-startup-template` package (8-role company scaffold, governance docs, skills, and import manifest).
  - Keeps onboarding/roles/skills structure in a reusable, importable package.
- `6da27f81` — **Dockerfile + runtime toolchain update**
  - Adds commonly used tools in image (`mc`, `nano`, `procps`, `zstd`, `tini`, `php-cli`, etc.).
  - Installs CLI/runtime helper packages used by adapters.
  - Switches container entrypoint to `tini` for cleaner signal handling.
  - Enables Codex/OpenAI tooling setup expected for local adapter runs.
- `b7aa3fb5` / `d9fb1fe7` — **docker-compose workflow refinements**
  - Adds/updates compose-level defaults and image reference wiring for deployments.

## Build and publish commands used

The commands from shell history you shared (`history | grep paperclip`) and your latest build/push actions are:

```bash
# Build the stable image with an OCI description label

docker build -t paperclip:v2026.403.1-stable \
  --label "org.opencontainers.image.description=v2026.403.1-stable - including companies-create-plugin - stable version" .

# Push to GitHub Container Registry

docker push ghcr.io/starlein/paperclip:v2026.403.1-stable
```

Other noteworthy history commands that prepared this patch stream:

```bash
cp _PATCH-feat-PAP-31-paperclip-startup-template.diff ..
patch -p0 < ../_PATCH-feat-PAP-31-paperclip-startup-template.diff
git add _PATCH-feat-PAP-31-paperclip-startup-template.diff docker-compose.yml
git commit -m "paperclip-startup-template"
git remote add kksecura https://github.com/kksecura/paperclip.git
```

## Run this image

### Quick run

```bash
mkdir -p ./data/docker-paperclip

docker run -d --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  -e PAPERCLIP_INSTANCE_ID=default \
  -e PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  -e PAPERCLIP_AUTH_SECRET="$(openssl rand -hex 32)" \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  ghcr.io/starlein/paperclip:v2026.403.1-stable
```

Open: `http://localhost:3100`

### Compose usage

Create your own compose file (or use repo `docker-compose.yml`) with at least:

```yaml
services:
  paperclip:
    image: ghcr.io/starlein/paperclip:v2026.403.1-stable
    environment:
      HOST: 0.0.0.0
      PORT: 3100
      NODE_ENV: production
      HOME: /paperclip
      PAPERCLIP_HOME: /paperclip
      PAPERCLIP_INSTANCE_ID: default
      PAPERCLIP_CONFIG: /paperclip/instances/default/config.json
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_AUTH_DISABLE_SIGN_UP: "true"
      PAPERCLIP_TELEMETRY_DISABLED: "true"
      PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      - ${PAPERCLIP_DATA_DIR:-./data/docker-paperclip}:/paperclip
```

## Companies starter template (included in this release)

If you want to import the bundled `paperclip-startup-template`:

```bash
paperclipai company import companies/paperclip-startup-template \
  --target new \
  --new-company-name "MyCompany" \
  --agents all \
  --yes
```

Verify first with:

```bash
paperclipai company import companies/paperclip-startup-template --dry-run
```

## Git base for this release

Last relevant commits on this branch:

```text
2a97d155 2026-05-29 Docker helpers
9f3ac37b 2026-05-29 paperclip-startup-template
d9fb1fe7 2026-05-22 docker-compose
b7aa3fb5 2026-05-22 docker-compose
b4acba70 2026-05-22 paperclip-startup-template
6da27f81 2026-05-22 dockerfile & gpt 5.5 update to codex
```

## Notes

- If you run in authenticated mode, keep `PAPERCLIP_AUTH_SECRET` stable across restarts.
- This image expects volume-mounted data at `/paperclip` for persistence.
- Built-in helper alias (`paperclipai`) is added in the container shell via `data/docker/.bashrc`.

---

Release notes target: Docker image only. For full app changelog, see `doc/*` and `releases/*.md` files in this repository.
