---
name: sourcegraph
description: Search code via Sourcegraph (bin/sourcegraph + SOURCEGRAPH_TOKEN)
when_to_use: When asked to search code, find definitions, explore repos, or look up symbols across the codebase
---

# Sourcegraph

Working CLI is on PATH: **`sourcegraph`** (harness `bin/sourcegraph`).

Auth: **`SOURCEGRAPH_TOKEN`** (or `SRC_ACCESS_TOKEN`) in harness `.env`.
Default URL: `https://sourcegraph.twitter.biz` (override with `SOURCEGRAPH_URL`).

If whoami fails with auth error, tell Christian the token is missing/expired — do **not** ship a stub skill and call it done.

## Commands

```bash
sourcegraph whoami
sourcegraph search 'repo:github.com/x-clients/x-chat listenAndRespond' --limit 15
sourcegraph search 'file:xchat.ts lastSeenId'
sourcegraph file github.com/x-clients/x-chat apps/xchat-agent/src/adapters/xchat.ts
sourcegraph gql '{ currentUser { username } }'
```

## Rules

1. Always run real searches; paste concrete repo/path/line hits back to the user.
2. Never invent file paths or code that search did not return.
3. Never print the token.
4. **Never open a PR that only adds a SKILL.md stub.** If the CLI is broken, fix `bin/sourcegraph` in the same change.
