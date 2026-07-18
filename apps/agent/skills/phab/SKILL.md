---
name: phab
description: Read and monitor Phabricator Differential revisions (D-numbers)
when_to_use: When asked about a phab, D1234567, differential, review status, or phabricator.twitter.biz links
---

# Phabricator

CLI on PATH: **`phab`**. Auth via `PHABRICATOR_CONDUIT_TOKEN` (already in agent env when deployed/local .env is loaded).

## Commands

```bash
phab whoami
phab view D1354783
phab view https://phabricator.twitter.biz/D1354783
phab status D1354783
phab comments D1354783
phab search "permanently-suspended XChat"
phab raw differential.revision.search '{"constraints":{"ids":[1354783]}}'
```

## Rules

1. Always call `phab view` / `status` for live state — don't invent review status.
2. Paste the D-number + title + status + uri back in chat (plain text, no markdown links if the channel is picky — bare URLs ok).
3. Never print `PHABRICATOR_CONDUIT_TOKEN` or `~/.arcrc`.
4. If auth fails, say conduit token is missing/expired — don't open a stub PR.
