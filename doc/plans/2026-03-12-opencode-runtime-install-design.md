# OpenCode Runtime Install Design

Status: Approved
Owner: Infrastructure + Runtime Tooling
Date: 2026-03-12

## Goal

Install `OpenCode` in the Paperclip VPS runtime environment under the same
runtime user context that already holds authenticated `claude` and `codex`
state, then prepare that runtime for `z.ai` (`GLM-5`) and `MiniMax` (`M25`)
provider integration.

## Context

- Prior runtime auth is already persisted under `/paperclip/.claude` and
  `/paperclip/.codex`.
- The production image already includes `openssh-client`.
- The desired install target is the Paperclip runtime/container, not the raw
  VPS host OS.

## Chosen Approach

Bake or install `OpenCode` in the Paperclip runtime/container so the CLI runs
as the same `paperclip` runtime user that already has the working auth state.
Prefer a runtime-user install path and config under `/paperclip` so the tool can
reuse the same persistent home volume semantics as the existing agent tooling.

## Alternatives Considered

1. One-off install in the current running container.
   Fast, but lost on container replacement.

2. Host-level VPS install.
   Easier to do manually, but splits the tool from the runtime user context we
   already verified.

3. Runtime-container install with runtime-user persistence.
   Chosen because it aligns with the existing `claude`/`codex` setup and keeps
   agent tooling in one operational context.

## Architecture

1. Connect to the VPS and inspect the current Paperclip deployment layout.
2. Identify the running Paperclip container and confirm the runtime user and
   writable home path.
3. Install `OpenCode` using its supported install flow inside the runtime
   environment.
4. Verify the binary is available to the `paperclip` runtime user.
5. Inspect `OpenCode` provider/config conventions.
6. Add `z.ai` and `MiniMax` provider configuration through runtime-user config
   and environment variables.
7. Validate that the CLI can list or select those models/providers without
   breaking the existing runtime environment.

## Error Handling

- If the install only works as root or only on the host, stop and reassess
  instead of silently drifting away from the approved runtime-user design.
- If the runtime filesystem is not persistent enough for the configuration, move
  to an image-level change instead of relying on ad hoc manual steps.
- If provider support is not native in `OpenCode`, document the exact gap before
  attempting unofficial configuration.

## Verification

- `OpenCode` executable resolves for the `paperclip` runtime user.
- Runtime config is stored under the persistent runtime user home.
- Provider credentials are injected via env/config rather than hardcoded.
- Existing `claude` and `codex` auth state remains intact.
