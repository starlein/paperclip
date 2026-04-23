---
name: project-paperclip
description: Project-specific procedures for Paperclip. Read this before working on this repo.
version: 1.0.0
---

# Paperclip

## Quick Reference

| What | Command |
|------|---------|
| Install | `pnpm install` |
| Test | `pnpm test:run` |
| Build | `pnpm -r typecheck && pnpm build` |
| Node | 22 |
| Python | N/A |

## Before You Start

1. Read `PROJECT.md` — project state and architecture
2. Read `AGENTS.md` (if exists) — agent-specific rules
3. Check `CONTRIBUTING.md` — conventions for this project
4. Check open issues: `gh issue list --repo paperclipai/paperclip --state open`

## Branch Convention

```
hermes/{issue}-{short-description}
codex/{issue}-{short-description}
claude/{issue}-{short-description}
```

## Before You Push

1. Run tests: `pnpm test:run`
2. Run build: `pnpm -r typecheck && pnpm build`
3. Update `PROJECT.md` if status changed
4. Never push to main/master directly

## Upstream Sync

This is a fork of `paperclipai/paperclip`.

```bash
cd ~/projects/paperclip
git fetch upstream
git rev-list --count origin/main..upstream/main  # check how far behind
```

To sync: follow the `upstream-sync` skill or the cron job handles it daily at 8 AM.

## Gotchas

<!-- Add project-specific gotchas here as you discover them -->

- 
