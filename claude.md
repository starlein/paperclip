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

---

## Connie Wallet Custody Chain (Phase 1)

Imported March 2026. Do not rotate or revoke without board approval.

### Asset facts

| Field | Value |
|-------|-------|
| Address | `0xa2e4B81f2CD154A0857b280754507f369eD685ba` |
| Network | Base mainnet (chain ID `8453`) |
| Token | USDbC (`0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`) |
| Balance at import | ~`$10.08 USDbC` |
| Source | Connie VPS `/root/.automaton-research-home/.automaton/wallet.json` |
| Owner | DLD Ent. board |

### Paperclip secret

| Field | Value |
|-------|-------|
| Secret name | `connie-wallet-private-key` |
| Secret ID | `bf9909ac-eb5a-452e-8bdb-e2d39194070f` |
| Provider | `local_encrypted` (AES-256-GCM, master key in `paperclip-server-1`) |
| Company ID | `f6b6dbaa-8d6f-462a-bde7-3d277116b4fb` (DLD Ent.) |

### Agent binding policy

| Env key | Type | Authorized agents |
|---------|------|-------------------|
| `CONNIE_WALLET_PRIVATE_KEY` | `secret_ref` | Treasury Operator (`d6f1aff9-8a41-4225-8ff2-fabc07e3476d`) only |
| `CONNIE_WALLET_ADDRESS` | `plain` | Any agent referencing wallet publicly |
| `CONNIE_WALLET_CHAIN_ID` | `plain` | Any agent |
| `CONNIE_WALLET_NETWORK` | `plain` | Any agent |
| `CONNIE_WALLET_TOKEN_CONTRACT` | `plain` | Any agent |

Only the CEO role can add or remove `secret_ref` bindings via `PATCH /api/agents/:id/permissions`.

### Wallet helper code

- `server/src/wallet/connie-wallet.ts` — `getAddressFromKey`, `validateWalletEnv`, `signMessageWithEnvKey`
- `server/src/wallet/signer-service.ts` — `SignerService` interface + phase-1 env shim; phase-2 target

### Revocation procedure

To stop signing access without destroying the secret:

```bash
# Remove secret_ref from Treasury Operator env (patch via DB or CEO-auth API)
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip \
    -c \"UPDATE agents SET adapter_config = adapter_config #- '{env,CONNIE_WALLET_PRIVATE_KEY}', updated_at = now() \
         WHERE id = 'd6f1aff9-8a41-4225-8ff2-fabc07e3476d';\""

# Confirm the key is gone from the agent env
docker exec paperclip-db-1 psql -U paperclip paperclip -t \
  -c "SELECT adapter_config->'env' FROM agents WHERE id='d6f1aff9-8a41-4225-8ff2-fabc07e3476d';"
```

The encrypted secret record is preserved for recovery. Delete the `company_secrets` row only if compromise is confirmed.

### Key rotation procedure

1. Generate a new EVM wallet on a secure, air-gapped machine.
2. Fund from current address via a Base bridge or direct transfer.
3. Import new key as a new version of `connie-wallet-private-key` via the gen-secrets script.
4. Update `CONNIE_WALLET_ADDRESS` plain value on all agents.
5. Confirm new address is resolving correctly in heartbeat logs.
6. Remove old key version (retain record; delete sensitive material only).

### Phase-2 migration path

See `server/src/wallet/signer-service.ts` for the `SignerService` interface. Phase-2 removes `CONNIE_WALLET_PRIVATE_KEY` from agent env entirely; agents call the signer service endpoint and never see the raw key.
