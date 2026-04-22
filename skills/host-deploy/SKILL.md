---
name: host-deploy
description: >
  SSH from the Docker container to the host server to deploy, test, manage
  services, edit configs, and run scripts for company repos. Use when you
  need to execute commands on the host machine — run tests, start/stop
  services, check logs, manage systemd units, edit configuration files,
  pull latest code, build, or perform any host-level operations for
  trtools2, sb_wtools, or other company repos. Do NOT use for work that
  can be done entirely inside the container (e.g. reading mounted /wp files,
  git operations on mounted repos). Use this skill specifically when you
  need host-level execution: running binaries, managing services, accessing
  host-only resources, or deploying.
---

# Host Deploy Skill

You have SSH access from this Docker container to the host server (`loft24551`).
This lets you execute commands directly on the host as user `trbck` — deploy
services, run tests, manage processes, edit configs, and operate on company repos.

## SSH Connection

**Always use this exact SSH command pattern:**

```bash
ssh -F /paperclip/.ssh/config hostmachine "<command>"
```

The SSH config at `/paperclip/.ssh/config` is pre-configured with the correct
host, port, user, and identity key. Never override these settings or use raw
`ssh` commands with manual host/port/key arguments.

**For multi-line or complex commands**, use a heredoc:

```bash
ssh -F /paperclip/.ssh/config hostmachine bash <<'REMOTE'
cd /home/trbck/wp/trtools2
make test
echo "exit code: $?"
REMOTE
```

**For interactive-style sequences** (where you need output between steps), run
separate SSH commands — each is a fresh shell on the host.

## Path Mapping — Container vs Host

**This is critical.** The repo paths you see inside this container are NOT the
same paths on the host. You MUST translate paths when SSH-ing out.

| Inside container (you)  | On host via SSH              |
| ----------------------- | ---------------------------- |
| `/wp/`                  | `/home/trbck/wp/`            |
| `/wp/trtools2/`         | `/home/trbck/wp/trtools2/`   |
| `/wp/sb_wtools/`        | `/home/trbck/wp/sb_wtools/`  |
| `/wp/<any-repo>/`       | `/home/trbck/wp/<any-repo>/` |

**Rule:** When you read or edit files locally, use `/wp/<repo>/`. When you SSH
to the host to run, deploy, or manage anything, always use `/home/trbck/wp/<repo>/`.

The mapping is simple — prepend `/home/trbck` to any `/wp/...` path you know
from inside the container. This applies to every repo, current and future.

Example — you find a config issue at `/wp/trtools2/config/feed.yaml` inside the
container, then need to restart the service on the host:
```bash
# Edit locally (container path)
# ... edit /wp/trtools2/config/feed.yaml ...

# Then restart on host (host path — note /home/trbck prefix)
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/trtools2 && make restart"
```

**Never use `/wp/...` paths in SSH commands — they do not exist on the host.**

## Host Environment

| Property       | Value                          |
| -------------- | ------------------------------ |
| Hostname       | `loft24551`                    |
| SSH port       | `20200` (handled by config)    |
| SSH key        | `/paperclip/.ssh/paperclip_deploy` (handled by config) |
| User           | `trbck` (uid 10003)           |
| OS             | Ubuntu (Linux 5.15)            |
| Home           | `/home/trbck`                  |
| Repos base     | `/home/trbck/wp/`             |
| Docker access  | Yes (`trbck` is in `docker` group) |
| Systemd access | User-level (`systemctl --user`) |

## Setting Up a New Repo on the Host

When a task requires setting up a new repository (new project, scaffold, or
clone) that agents will work on, follow this exact workflow:

### 1. Clone / create the repo on the host

```bash
ssh -F /paperclip/.ssh/config hostmachine bash <<'REMOTE'
cd /home/trbck/wp
# Clone existing repo:
git clone <repo-url> <repo-name>
# OR scaffold a new repo:
mkdir -p <repo-name> && cd <repo-name> && git init
REMOTE
```

The repo is immediately visible inside this container at `/wp/<repo-name>`
because `/home/trbck/wp` is mounted at `/wp`. No Docker restart needed.

### 2. Install dependencies on the host

Run language-specific setup **on the host** via SSH (not inside the container):

```bash
ssh -F /paperclip/.ssh/config hostmachine bash <<'REMOTE'
cd /home/trbck/wp/<repo-name>
# Node/pnpm
pnpm install
# Python
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
# Go
go mod download
REMOTE
```

### 3. Verify the repo is accessible inside the container

After cloning, verify by reading a file locally (no SSH needed):
```bash
ls /wp/<repo-name>
cat /wp/<repo-name>/README.md
```

### 4. Register it as a Paperclip workspace (if needed for agents)

If this repo will be used as a project workspace in Paperclip, set the
project workspace `cwd` to `/wp/<repo-name>` via the Paperclip API or UI.
This is the container-side path — Paperclip's agents see it at `/wp/<repo-name>`.

**Important:** Do NOT use `/home/trbck/wp/<repo-name>` as the workspace `cwd`
inside Paperclip — that path only exists on the host, not in this container.

### 5. Update this SKILL.md

After setting up the repo, add it to the "Company Repos" section below
following the established pattern.

---

## Company Repos

All repos live under `/home/trbck/wp/` on the host, mounted into this container
at `/wp/`. You can read and edit files locally at `/wp/<repo>`, but **execution**
(running binaries, tests, services, deploys) must happen via SSH using the
**host path** `/home/trbck/wp/<repo>`. See the path mapping table above.

### trtools2 — `/home/trbck/wp/trtools2`

Trading tools platform. Mixed Go + Python codebase.

- **Go services**: `cmd/feed-engine/main.go`, packages under `internal/`
- **Python engine**: `engine/` directory (orchestrator, CLI)
- **Build**: `make` (see `Makefile` for targets)
- **Config**: `config/` directory
- **Deploy scripts**: `deploy/` directory
- **Strategies**: `strategies/` directory

Common operations:
```bash
# Build Go binaries
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/trtools2 && make build"

# Run Go tests
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/trtools2 && make test"

# Run the feed engine
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/trtools2 && go run cmd/feed-engine/main.go"

# Run Python engine
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/trtools2 && cd engine && python3 -m orchestrator.engine"

# Check running processes
ssh -F /paperclip/.ssh/config hostmachine "pgrep -af 'feed-engine|engine.py'"
```

### sb_wtools — `/home/trbck/wp/sb_wtools`

Python-based tools. Has APIs, database layer, news API integration.

- **Source**: `src/` directory
- **APIs**: `apis/`, `wpapi/`, `newsapi/`
- **Tests**: `tests/` directory
- **Config**: `config.yaml`, `config/` directory
- **Database**: `db/` directory

Common operations:
```bash
# Run tests
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/sb_wtools && python3 -m pytest tests/ -v"

# Run with coverage
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/sb_wtools && python3 -m pytest tests/ --cov=src"

# Start a service
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/sb_wtools && python3 -m src.main"

# Check config
ssh -F /paperclip/.ssh/config hostmachine "cat /home/trbck/wp/sb_wtools/config.yaml"
```

## Operations Guide

### Running Tests

Always run tests before and after making changes to verify nothing is broken:

```bash
# Single repo
ssh -F /paperclip/.ssh/config hostmachine "cd /home/trbck/wp/<repo> && <test-command>"

# Check exit code explicitly
ssh -F /paperclip/.ssh/config hostmachine bash <<'REMOTE'
cd /home/trbck/wp/trtools2
make test
echo "TEST_EXIT_CODE=$?"
REMOTE
```

### Service Management

Check, start, stop, and restart services on the host:

```bash
# List running processes for a repo
ssh -F /paperclip/.ssh/config hostmachine "pgrep -af '<process-name>'"

# Check systemd user services
ssh -F /paperclip/.ssh/config hostmachine "systemctl --user list-units --type=service --state=running"

# Start/stop/restart a systemd user service
ssh -F /paperclip/.ssh/config hostmachine "systemctl --user start <service-name>"
ssh -F /paperclip/.ssh/config hostmachine "systemctl --user stop <service-name>"
ssh -F /paperclip/.ssh/config hostmachine "systemctl --user restart <service-name>"

# Check service logs
ssh -F /paperclip/.ssh/config hostmachine "journalctl --user -u <service-name> --no-pager -n 50"
```

### Deployment

```bash
# Pull latest, build, deploy
ssh -F /paperclip/.ssh/config hostmachine bash <<'REMOTE'
cd /home/trbck/wp/<repo>
git pull origin main
# run build steps
# restart services
REMOTE
```

### Editing Config Files

For small config changes, use `sed` or write via heredoc:

```bash
# View a config
ssh -F /paperclip/.ssh/config hostmachine "cat /home/trbck/wp/<repo>/config.yaml"

# Edit with sed
ssh -F /paperclip/.ssh/config hostmachine "sed -i 's/old_value/new_value/' /home/trbck/wp/<repo>/config.yaml"
```

For larger edits, modify the file through the mounted `/wp` volume inside the
container (no SSH needed for file edits), then restart the service via SSH.

### Checking Logs and Diagnostics

```bash
# System resources
ssh -F /paperclip/.ssh/config hostmachine "free -h && df -h /home/trbck"

# Process list
ssh -F /paperclip/.ssh/config hostmachine "ps aux | grep -E 'trtools|sb_wtools|feed-engine'"

# Network ports in use
ssh -F /paperclip/.ssh/config hostmachine "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null"

# Docker containers on host
ssh -F /paperclip/.ssh/config hostmachine "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

### Host Docker Operations

The host user has docker access, so you can manage containers:

```bash
ssh -F /paperclip/.ssh/config hostmachine "docker ps"
ssh -F /paperclip/.ssh/config hostmachine "docker logs <container> --tail 50"
ssh -F /paperclip/.ssh/config hostmachine "docker restart <container>"
```

## Safety Rules

1. **Never run destructive commands** without explicit task authorization
   (e.g. `rm -rf`, dropping databases, stopping production services).
2. **Always verify the current state** before making changes — check what's
   running, read configs, run tests first.
3. **Back up config files** before editing them:
   ```bash
   ssh -F /paperclip/.ssh/config hostmachine "cp /path/to/config.yaml /path/to/config.yaml.bak"
   ```
4. **Prefer the mounted /wp volume** for reading/writing files when possible.
   Only use SSH when you need to execute something on the host.
5. **Report outcomes** — always check and report exit codes, test results,
   and service status after operations.
6. **Do not install system packages** (`apt install`) without explicit approval.
7. **Do not modify SSH keys or auth** — the SSH setup is managed externally.

## Troubleshooting

**SSH connection refused**: The host SSH server runs on port `20200` (not 22).
The config at `/paperclip/.ssh/config` handles this automatically — always
use `-F /paperclip/.ssh/config` and never specify port or key manually.

**Permission denied**: Commands run as `trbck` (uid 10003). If something
requires root, it cannot be done via this skill — flag it in the task.

**Command not found**: The host has Go, Python 3, make, docker, and standard
Unix tools. For language-specific tools, check if they're installed first:
```bash
ssh -F /paperclip/.ssh/config hostmachine "which go python3 make docker node"
```

**Long-running commands**: For commands that take more than a few minutes,
consider running them in the background with `nohup` or `screen`/`tmux`:
```bash
ssh -F /paperclip/.ssh/config hostmachine "nohup /home/trbck/wp/trtools2/cmd/feed-engine/main -c config.yaml > /tmp/feed-engine.log 2>&1 &"
```
