---
name: self-update
description: Pull latest harness agent code and redeploy this process
when_to_use: When asked to update yourself, pull latest, redeploy, restart after a merge
---

# Self-update

You are the **harness product agent** (`xchat-agent-harness`), not upstream x-chat.

## Layout
- Bot code you edit: `apps/agent/**` in the harness repo
- SDK you import: `@x-chat/xchat-sdk`, `@x-chat/drone-core` (linked from sibling `x-chat`)
- Skills: `skills/` and `apps/agent/skills/`

## Ship code
1. Implement in harness `apps/agent/` (real code, not docs-only).
2. SDK-level fixes → PR against `x-clients/x-chat` packages.
3. Commit + `gh pr create` on **tatanpoker09/xchat-agent-harness** for bot changes.

## Redeploy
Call **`restart_agent`** (admin). Runs `scripts/restart.sh` which pulls **this** repo and respawns.
Log: `/tmp/xchat-restart.log`
