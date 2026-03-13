## Paperclip VPS credentials

- IP: `64.176.199.162`
- SSH: `root@64.176.199.162`
- Password: `bS%4nhouDq+gayS[`

## Notes

- Paperclip path: `/opt/paperclip`
- Docker Compose: `docker compose -f docker-compose.quickstart.yml`
- URL: http://64.176.199.162:3100
- Current deployed stack is running and healthy on `0.0.0.0:3100`
- Health check verified: `curl http://localhost:3100/api/health` returns `200 OK`

## Deployment progress

- The slow VPS rebuild issue was caused by rebuilding the UI on the VPS in the default `Dockerfile`
- Fast-build path is now available:
  - `Dockerfile.vps`
  - `docker-compose.vps.yml`
  - `docker-compose.vps-override.yml`
- Fast-build flow uses prebuilt `ui/dist` and skips the VPS UI build step
- The production image now includes `openssh-client`
- OpenCode is now deployed through the Paperclip-native runtime path instead of the earlier manual wrapper
- The running container now uses:
 - `PAPERCLIP_OPENCODE_COMMAND=/paperclip/bin/opencode`
 - `/paperclip/bin/opencode -> /opt/paperclip-opencode/node_modules/.bin/opencode`
 - `OPENCODE_CONFIG_CONTENT` with `ZAI_API_KEY` and `MINIMAX_API_KEY` sourced from deployment env
- Live model discovery is verified in the running container:
 - `zai/glm-5`
 - `minimax/MiniMax-M2.5`
- A rebuild initially failed during Docker image export because the VPS root disk was at `99%`
- Recovery was:
 - prune unused Docker data
 - rebuild `paperclip-server`
 - recreate `paperclip-server-1`
- Current rebuilt image size is about `952MB`
- Verified in the running container:
  - `ssh -V`
  - `ssh-add`
  - `ssh-keyscan`

## Runtime auth state

- Codex auth was copied from VPS host root auth into the runtime user's persisted home at `/paperclip/.codex`
- Verified as runtime user: `codex login status` reports logged in
- Claude Code is installed globally in the container and authenticated for the runtime user
- Verified as runtime user:
  - `claude --version`
  - `claude auth status`
- Claude auth is persisted under `/paperclip/.claude`

## CTO agent status

- CTO agent adapter type: `codex_local`
- Prior failing CTO run showed OpenAI `401 Unauthorized: Missing bearer or basic authentication in header`
- A fresh end-to-end CTO heartbeat was invoked after the fixes and succeeded
- Verified successful CTO run:
  - Agent id: `cfd857ce-4110-4f51-b996-17b8eb02bc7b`
  - Run id: `aeeda432-c3ba-41e6-b980-e8e8f5a1783c`
  - Final status: `succeeded`
- Current CTO agent status is `idle`

## Operational notes

- New SSH sessions from external tooling may time out during banner exchange when the VPS is under heavy load, even while an already-open interactive SSH session still works
- The container image does not include the `ps` utility; `docker exec ... ps` failing is not itself an app failure
- URL: http://64.176.199.162:3100
