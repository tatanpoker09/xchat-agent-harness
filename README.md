# xchat-agent-harness

**Product agent for `@tatanbotter09`.**

This repo owns the bot. Upstream [x-clients/x-chat](https://github.com/x-clients/x-chat) is consumed as an **SDK** (packages only), not as the app you edit day-to-day.

```
xchat-agent-harness/          ← you are here (bot product)
  apps/agent/                 ← bot runtime (loop, tools, adapters, skills)
  packages/
    xchat-sdk → symlink       ← SDK from sibling x-chat
    drone-core → symlink      ← brain/heartbeat core from sibling x-chat
  skills/                     ← skills source (synced into apps/agent/skills)
  scripts/                    ← start / restart / setup

../x-chat/                    ← SDK source (do not fork full agent here)
  packages/xchat-sdk
  packages/drone-core
```

## Setup

```bash
# sibling layout required:
#   ~/Documents/Programming/x-chat
#   ~/Documents/Programming/xchat-agent-harness

pnpm setup          # link SDK packages
pnpm install
cp .env.example .env   # or symlink ../x-chat/.env
```

## Run

```bash
pnpm start                 # --as tatanbotter09
pnpm start:tmux            # supervised (restart_agent friendly)
# or
bun run apps/agent/bin/main.ts --as tatanbotter09
```

## What goes where

| Change | Repo / path |
|--------|-------------|
| Bot behavior, message queue, tools, prompts, skills | **this repo** `apps/agent/**` |
| Encrypted DM client, crypto, GraphQL, storage | **x-chat** `packages/xchat-sdk` (PR upstream) |
| Brain/heartbeat primitives | **x-chat** `packages/drone-core` (PR upstream) |
| Persona / memory markdown | `~/.xchat/accounts/<handle>/brain` (git remote) |

## Self-update

Admin DM → tool `restart_agent` → `scripts/restart.sh`:

1. Re-link SDK
2. `git pull` **this** repo
3. `pnpm install`
4. Respawn under tmux/nohup

Log: `/tmp/xchat-restart.log`

## Implementing features

Open PRs **here** with real code under `apps/agent/`.  
Do not ship docs-only proposals. Use x-chat only when the fix belongs in the shared SDK.

## Kubernetes

See [docs/DEPLOY.md](docs/DEPLOY.md).

```bash
./deploy/agent/deploy.sh @tatanbotter09
```
