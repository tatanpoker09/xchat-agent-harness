---
name: kmp-dogfood
description: Run XChat KMP sync harness scenarios, summarize failures, open issues/PRs
when_to_use: When asked to check missing messages, sync bugs, TC/BC races, or dogfood KMP; or on heartbeat when monitoring is enabled
---

# KMP dogfood

You are exercising the **production KMP client path** via the standalone harness,
not the TS SDK transport you use to chat.

## Paths (laptop or pod checkout)

Assume sibling layout under a programming root (adjust if different):

```
$PROG/x-android
$PROG/xchat-sync-harness
$PROG/tatanbot
$PROG/x-chat
```

Default `PROG=/Users/ceilers/Documents/Programming` locally. On the pod, clone
into `/data/src/` if missing (needs network + `gh` auth).

## Dry suite (always safe)

```bash
cd "$PROG/xchat-sync-harness"
./run-tests.sh --mode=dry
# or focused:
./run-tests.sh --mode=dry --tests 'com.x.dms.syncharness.scenarios.*'
```

Report: which scenario ids failed, one-line mechanism, whether already catalogued
in harness README (`tc-max-seq-claim-without-payload`, etc.).

## Live connectivity (read-only CES)

Only when env is present (`X_USER_ID`, S2S/proxee or cookie transport). Prefer
S2S in-cluster. Never send mutations from the harness.

```bash
export HARNESS_TRANSPORT=s2s STRATO_PORT=8001 X_USER_ID='…'
./run-tests.sh --mode=live --tests 'com.x.dms.syncharness.scenarios.LiveModeTests'
```

## When you find a real bug

1. Capture: scenario id, logs snippet, suspected component path under `x-android/subsystem/dm`.
2. Tell Christian in the 1:1 with a short repro.
3. If asked to fix: branch from latest `x-android`, minimal patch, **draft PR**,
   title tag `[XChat]…` per x-android AGENTS.md. Do not merge unless told.
4. Optionally open Linear issue if `linear-cli` skill + auth available.

## Missing-message heuristics (agent-side)

While chatting on TS transport, still note:

- `message_skipped` / `encrypted` / `ckeyCount:0` in your own logs
- user reports of gaps vs what `search_messages` / inbox shows
- WS disconnect streaks without successful `inbox_catch_up`

Correlate with harness catalog before claiming a new KMP bug.

## Don’t

- Don’t treat harness live mode as a write client.
- Don’t paste cookies or PINs into chat or commit them.
- Don’t force-push `main` on `x-android` or `x-chat`.
