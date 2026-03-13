# OpenCode Runtime Install Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Install `OpenCode` for the Paperclip runtime user inside the VPS runtime/container, then configure and verify `z.ai` (`GLM-5`) and `MiniMax` (`M25`) support in that same runtime context.

**Architecture:** Work against the existing VPS deployment and locate the active Paperclip runtime container. Verify the `paperclip` runtime user's home and persistence model, install `OpenCode` with its official install method inside that environment, then add provider configuration with environment-backed credentials and validate model/provider visibility from the CLI.

**Tech Stack:** Docker, Linux shell, OpenCode CLI, Paperclip runtime container, persisted runtime home at `/paperclip`

---

### Task 1: Inspect the VPS runtime layout

**Files:**
- Check: `CLAUDE.md`
- Check: `doc/plans/2026-03-12-opencode-runtime-install-design.md`

**Step 1: Connect to the VPS**

Run:

```bash
ssh root@64.176.199.162
```

Expected: interactive shell on the Paperclip VPS.

**Step 2: Confirm the app path and compose files**

Run:

```bash
cd /opt/paperclip
ls
```

Expected: repository files plus the compose files referenced in `CLAUDE.md`.

**Step 3: Identify running containers**

Run:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Expected: the active Paperclip application container is visible.

**Step 4: Commit checkpoint**

Do not create a git commit for server inspection only.

### Task 2: Confirm runtime user and persistent home

**Files:**
- Check: runtime container environment

**Step 1: Inspect the runtime user**

Run:

```bash
docker exec <paperclip-container> sh -lc 'id && whoami && echo "$HOME" && ls -la /paperclip'
```

Expected: output confirms the runtime user and shows the persisted `/paperclip` home content.

**Step 2: Verify existing auth state**

Run:

```bash
docker exec <paperclip-container> sh -lc 'ls -la /paperclip/.claude /paperclip/.codex'
```

Expected: both directories exist.

**Step 3: Verify existing CLIs still resolve**

Run:

```bash
docker exec <paperclip-container> sh -lc 'claude --version && codex --version'
```

Expected: both commands succeed.

**Step 4: Commit checkpoint**

Do not create a git commit for runtime inspection only.

### Task 3: Inspect OpenCode install and config requirements

**Files:**
- Check: `https://opencode.ai/`

**Step 1: Read the official install command**

Run:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Expected: review the installer behavior before using it in the runtime context.

**Step 2: Identify binary install location and shell profile changes**

Check whether the installer writes to:

- a user-local bin directory
- a shell rc/profile file
- a config directory such as `~/.config`

Expected: enough detail to adapt the install to the non-interactive runtime environment.

**Step 3: Inspect CLI help for provider/model configuration**

Run after install in a disposable or review mode:

```bash
opencode --help
```

Expected: commands or config references for provider/model setup.

**Step 4: Commit checkpoint**

Do not create a git commit for external-tool inspection only.

### Task 4: Install OpenCode in the runtime container

**Files:**
- Modify: runtime user environment inside the active container

**Step 1: Run the installer as the runtime user**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'cd /paperclip && curl -fsSL https://opencode.ai/install | bash'
```

Expected: `OpenCode` installs into a user-owned location without requiring root.

**Step 2: Expose the binary for non-interactive shells**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'export PATH="$HOME/.local/bin:$PATH" && opencode --version'
```

Expected: `opencode --version` succeeds.

**Step 3: Confirm persistence-relevant paths**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'printf "HOME=%s\n" "$HOME" && ls -la "$HOME" && ls -la "$HOME/.config" 2>/dev/null || true'
```

Expected: installed files live in runtime-user-owned paths that are acceptable for this environment.

**Step 4: Commit checkpoint**

Do not create a git commit unless an image or repo file needs updating for persistence.

### Task 5: Configure `z.ai` and `MiniMax`

**Files:**
- Modify: OpenCode runtime-user config under `/paperclip`
- Modify: runtime environment variables if required

**Step 1: Discover the exact config format**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'export PATH="$HOME/.local/bin:$PATH" && opencode config --help || opencode --help'
```

Expected: enough information to find the supported config structure.

**Step 2: Add provider credentials through env-backed config**

Use provider-specific environment variables and a runtime-user config file. Do
not hardcode secrets into repo files.

Expected: config references `z.ai`/`GLM-5` and `MiniMax`/`M25` with secrets
coming from environment variables.

**Step 3: Validate provider visibility**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'export PATH="$HOME/.local/bin:$PATH" && opencode --help'
```

Then run the relevant model/provider listing or dry-run command discovered in
Step 1.

Expected: both providers/models are recognized by the CLI.

**Step 4: Commit checkpoint**

If repo-managed deployment files need env/config updates for persistence, create
a normal git commit after verification.

### Task 6: Final verification and documentation

**Files:**
- Modify: deployment docs only if the persistence method requires it

**Step 1: Re-check the runtime user**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'export PATH="$HOME/.local/bin:$PATH" && whoami && opencode --version'
```

Expected: `paperclip` and a working `OpenCode` version output.

**Step 2: Verify existing agent tooling still works**

Run:

```bash
docker exec -u paperclip <paperclip-container> sh -lc 'claude auth status && codex login status'
```

Expected: both auth states remain valid.

**Step 3: Record operational notes**

Document:

- install location
- config path
- required provider env vars
- whether the install survives container replacement

**Step 4: Commit**

If docs or deployment files changed:

```bash
git add <updated-files>
git commit -m "chore: add opencode runtime installation notes"
```
