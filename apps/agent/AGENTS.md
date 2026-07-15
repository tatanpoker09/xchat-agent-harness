# xchat-agent

> ## 📓 This is a living document — agents must maintain it
>
> If you learn something useful, get surprised, find a better way to do
> something, waste time on a trap someone else could avoid, or notice that
> something written here is wrong or stale — **update this file in the same
> change.** You are in full control of it and it is *your* responsibility to
> keep it accurate, useful, and concise. Don't ask permission; just improve it.
> Add what's true, delete what's no longer true, and prefer hard facts +
> exact commands over vague advice. Future agents (and you, next week) rely
> on this being trustworthy.

Long-running autonomous bot that watches an X account's DMs and replies via
Grok. Runs as a Bun process; one instance per bot account. In production it's
a Kubernetes StatefulSet (one per bot) that self-recovers all state on boot.

---

## Layout

```
bin/main.ts            — entry point: boots the SDK, runs Juicebox recovery on
                         cold-start if identity keys are missing, starts adapters
src/Agent.ts           — the agent loop (model ↔ tool calls). Also prunes old
                         tool-result text to bound the context (see below)
src/adapters/          — stdin (interactive) + xchat (the DM watcher)
src/config.ts          — agent-config.json loader + fs.watch hot-reload
src/logger.ts          — JSONL logger (tees to stdout for `kubectl logs`)
src/tools/             — Effect Toolkit definitions + executors
src/XaiLanguageModel.ts— custom xAI Responses-API provider (see "Model layer")
src/skills.ts          — discovers skills/ + skills under <repo>/skills/
deploy/agent/          — Dockerfile + entrypoint.sh (sources the TSS env) +
                         xctl spec (twitterSecrets) + deploy.sh + diag.sh
```

---

## Conventions (read before editing code)

- **No `try`/`catch`. Anywhere.** All error handling stays in the Effect
  channel — `Effect.fail`, `Effect.catch`, `Effect.orElseSucceed`,
  `Effect.retry`, `Effect.mapError`, etc. Never `throw`.
- Effect-TS throughout. Tools return `Effect<string, …>`; handlers are gated +
  logged by the `logged` wrapper in `tools/xchat-tools.ts`.
- Every message handler emits structured JSONL via `log({ type, ... })`.
- `--as <handle>` is required for the xchat adapter; bare `bun main.ts` runs
  stdin-only mode (no SDK deps) for quick sanity checks.
- `fs.watch` hot-reloads **everything**, including `allowedConversationIds`:
  each reload bumps a `configVersion` that wakes the adapter's reconcile loop
  (`listenAndRespond`), which forks watchers for added conv ids and interrupts
  watchers for removed ones (within ~1s). Look for `watcher_reconcile` log
  lines. An added conversation starts from a fresh `lastSeenId` — messages
  sent before the watcher attached are deliberately skipped, same as boot.
  `speakUnprompted` and `drone.heartbeat` hot-reload too (read fresh each
  wake/cycle). The ONE boot-time item is `drone.brain.remote` — changing the
  brain's identity source is deliberately a restart.
- Effect here is `4.0.0-beta.76` ("smol" build). APIs differ from Effect 3 —
  e.g. `Effect.retry({ schedule, times, while })`, `Schedule.recurs/exponential/
  jittered`. Check `node_modules/effect/dist/*.d.ts` before guessing.

---

## Configuration — `agent-config.json`

Lives at `~/.xchat/accounts/<handle>/agent-config.json` (locally) and is
base64'd into the TSS material as `XCHAT_AGENT_CONFIG_B64` (prod). Schema
(validated in `src/config.ts`):

```jsonc
{
  "globalAdmins": ["<x-user-id>"],              // these users get globalAdminToolkits
  "globalAdminToolkits": ["xchat","xai","coding","core"],
  "botHandles": ["<handle>"],                   // used to detect @mentions
  "allowedConversationIds": ["<convId>", ...],  // ONLY these convs are watched
  "defaults": { "respondTo": "everyone", "trigger": "mention_only",
                "toolkits": ["xchat","xai"] },
  "conversations": {                            // per-conversation overrides
    "<convId>": { "trigger": "all_messages", "toolkits": ["xchat","xai"] }
  }
}
```

- `respondTo`: `"everyone"` | `"admins_only"`
- `trigger`: `"all_messages"` | `"mention_only"` (1:1s usually want
  `all_messages` — `mention_only` means it only replies to @mentions/replies,
  which rarely happens in a DM, so it looks dead)
- `toolkits`: `string[]` **or** `{ "admin": string[], "user": string[] }`
- A global admin's toolkits come from `globalAdminToolkits`, overriding the
  conversation's `toolkits` for that user.

### The drone: brain + heartbeat (docs/drone-core-design.md)

```jsonc
{
  // CHANNEL config (xchat conv ids): where the drone may speak UNPROMPTED.
  // Subset of allowedConversationIds, no "*", colon/g-form. Default [] =
  // wake turns are thinking-only. Hot-reloads (read fresh each wake).
  "speakUnprompted": ["2961965566:1977864154787741696"],

  // CORE config — zero channel vocabulary in here, ever.
  "drone": {
    "owner": "Zach",                          // used in the seeded soul
    "brain": { "remote": "https://github.com/<you>/<bot>-brain.git" },  // absent = local-only
    "heartbeat": {                            // absent = clock idles (hot enable by adding it)
      "intervalMinutes": 30,                  // floor 5; applies from next cycle
      "quietHours": { "start": "23:00", "end": "08:00", "timezone": "America/Los_Angeles" }
    }
  }
}
```

- **Brain** = a git repo of markdown at `<accountDir>/brain/` (soul.md,
  memory.md, people/, rooms/, journal/). Seeded on first boot; every model
  write auto-commits (`git log` = the drone's diary); push is debounced+async;
  pull conflicts log `brain_conflict` and skip — fix by hand, never
  auto-resolved. The drone reads/writes it via brain_list/read/write.
- **Brain remote on the pod**: add `BRAIN_GIT_TOKEN` (fine-grained, single
  repo) to the TSS material `xchat-agent/<handle>/env` and use an
  authenticated https remote. `github.com:443` must be reachable through the
  egress sidecar (the `restart_agent` git-pull path already relies on it).
  Brain rollback = `git revert` in the brain repo.
- **Heartbeat** = clock wakes with no inbound message: digests of watched
  convs + the wake prompt; reflection/follow-ups/monitoring are emergent.
  Wake turns are role-`user`, never `coding`, no current conversation, and
  every outbound tool is gated on `speakUnprompted`. Terminal text is
  suppressed — watch `heartbeat_wake`/`heartbeat_result` and the normal
  `tool_call`/`message_sent` lines. Muting the drone = set
  `speakUnprompted: []` (hot).
- **Alarms (self-scheduled exact wakes)** = `schedule_wake`/`cancel_wake`/
  `list_scheduled_wakes` (always-on "clock" toolkit, like "brain"). Stored in
  the brain at `alarms.md` (committed, survives restarts); the heartbeat loop
  sleeps to `min(next tick, soonest alarm)` and a mid-sleep schedule change
  re-plans immediately. Alarms fire at the EXACT time, pierce quiet hours,
  and fire even with `drone.heartbeat` absent — an explicit promise outranks
  the ambient schedule. An alarm wake is otherwise a normal wake (capture
  first, `speakUnprompted` still gates speech). `heartbeat_wake` log carries
  `alarms: [reasons]` when fired by one.

### Toolkit reference

| Toolkit | Tools |
|---|---|
| `xchat` | `view_media`, `react_to_message`, `send_message`, `search_messages`, `search_conversations`, `get_conversation_info`, `send_voice_note` |
| `xai`   | `generate_image`, `generate_video` |
| `coding`| `bash`, `bun_run` (powerful — admins only) |
| `core`  | `use_skill` (always on; runs skills in `skills/`) |

`configure_conversation`, `get_conversation_status`, `restart_agent` are
admin-gated at the handler level — not part of any toolkit.

---

## ⚠️ Conversation IDs — colon vs dash (silent-failure trap)

1:1 conversation IDs are stored, streamed, and matched as
**`<lowerUserId>:<higherUserId>` with a COLON** (the lower numeric user id
first). Group convs are `g<id>`. The allowlist and every tool's
`conversation_id` must use the colon form.

`MutationService.withUser` (in the SDK) builds the *dash* form
`<lower>-<higher>` for its resolve/create path — **that form is NOT what gets
stored or streamed.** If you put a dash-form id in `allowedConversationIds`,
the watcher attaches to an id that never matches an incoming message and
`send_message` blocks it as "not in the allowlist" → the bot silently never
works in that conversation. Always use the colon form. Verify against the DB:

```bash
sqlite3 ~/.xchat/accounts/<handle>/dm.sqlite \
  "SELECT DISTINCT conversation_id FROM effect_messages WHERE conversation_id NOT LIKE 'g%' LIMIT 20;"
```

---

## Local dev / full local test loop

Run a bot locally and drive it from a *second* account via the CLI — the two
talk over the real X DM backend (no mocks).

```bash
# 1. one-time: recover the bot's identity keys (needs its Juicebox PIN)
bun apps/xchat-cli/bin/cli.ts -a @<botHandle> recover-keys "<PIN>"

# 2. author ~/.xchat/accounts/<botHandle>/agent-config.json (see schema above);
#    allowlist the colon-form 1:1 id between the bot and your driver account.

# 3. boot the bot (XAI_API_KEY can be read from a sibling x-web repo's .env)
export XAI_API_KEY=$(grep '^XAI_API_KEY=' ../x-web/.env | cut -d= -f2-)
export XAI_MODEL=grok-4.3 XCHAT_LOG_LEVEL=Info
bun apps/xchat-agent/bin/main.ts --as <botHandle>   # boots WS + watches convs

# 4. drive it from the other account (separate ~/.xchat/accounts/<driver>)
bun apps/xchat-cli/bin/cli.ts -a @<driver> send <colon-conv-id> "hey"
bun apps/xchat-cli/bin/cli.ts -a @<driver> fetch-messages <colon-conv-id>
bun apps/xchat-cli/bin/cli.ts -a @<driver> messages <colon-conv-id> --limit 20
```

Watch the bot's behavior in its JSONL log
(`~/.xchat/accounts/<botHandle>/logs/agent-*.jsonl`): `message_received`,
`permission_check`, `tool_call`, `agent_response`, `message_sent`,
`agent_error`. A healthy `conversation_watch` shows `ckeyCount:1,
encryptedCount:0` for the watched 1:1 (it can decrypt). `ckeyCount:0` =
the bot can't read that conversation.

---

## The model layer — `XaiLanguageModel.ts` (and the 500 saga)

Custom provider over `POST https://api.x.ai/v1/responses`. Hard-won facts:

- Runs with **`store: false`** → stateless → the **entire** conversation
  (system prompt + full history + every prior `function_call` /
  `function_call_output`) is re-serialized into `input` on *every* turn.
- `previous_response_id` is gated off whenever `store !== false`, so today it's
  effectively unused. **`store: true` is a DEAD END for our key:** a follow-up
  with `previous_response_id` returns `404 "Response with id=… not found"`
  (the key doesn't retain server-side state — looks ZDR), and delta-only
  follow-ups still 500. Don't reach for it.
- **The intermittent 500 (`{"code":"Internal error","error":"Service
  temporarily unavailable."}`)** is NOT random provider flakiness — it's
  payload-shape-sensitive and scales with how many `function_call` items are in
  `input`. Measured rates (real API, same key): text-only **0%**, one paired
  call+output **~17%**, grouped parallel calls **~33%**, **dangling**
  `function_call` (no matching output) **~33–67%**.
- It *looked* provider-side because the body is generic **and** the old code
  swallowed it via `HttpClient.filterStatusOk`. With no retry, a single 500
  silently dropped the whole turn → the bot "ignored" the user.
- **What's in place now** (`generateText`): on non-2xx it reads the body and
  surfaces `xAI {status}: {body}`; it retries 5xx + **429** ("model is
  currently at capacity" — observed dropping turns live 2026-06-11) +
  transport errors up to 6× (~19s) with jittered exponential backoff.
  Other 4xx and decode errors are not retried. Every retried failure logs
  `xai_retry` (attempt, status, final). On top of that, the xchat adapter
  re-runs a whole dead TURN once, 45s later (`turn_retry` log) — necessary
  because `lastSeenId` advances before the turn runs and the catch-up poll's
  delta pull never re-fetches an already-ingested message, so an unretried
  failed turn means that message is silently unanswered FOREVER.
- `Agent.ts pruneOldToolResults` caps tool-result *text* (50KB budget) but keeps
  call↔output **pairing intact** — this keeps real payloads near the safe zone.
  A live bot survived 100+ tool calls (incl. parallel rounds) with 0 errors, so
  normal use rarely trips the 500; the retry covers the rest.
- The **doubled `tool_call` log line** is benign — it's logged from two sites
  (the executor `logged` wrapper in `tools/xchat-tools.ts` *and* the loop in
  `Agent.ts`), not a duplicate in the request.

---

## Reading X posts — `x_search` server-side tool

The bot can read shared X posts (text, the **whole thread**, and the
**images/videos** in them) via xAI's **`x_search`** server-side tool — no local
plumbing, xAI runs it inside the `/v1/responses` call.

- `XaiLanguageModel.serializeTools` appends `web_search` + `x_search` to every
  request (`buildServerTool`). The critical bit: `x_search` is emitted with
  **`enable_image_understanding` / `enable_video_understanding`** (XaiConfig,
  default on; env `XAI_X_SEARCH_{IMAGE,VIDEO}_UNDERSTANDING=false` to disable).
  **Without image understanding it fetches the thread text but ignores the
  pictures** — that flag is the whole point. Verified live: a bare `{type:
  "x_search"}` read an 8-image SpaceX thread's text only; with the flag it
  described all 8 slides (4 root + 4 first reply).
- The adapter surfaces a shared post's URL so the model knows *which* thread to
  read: `adapters/annotate.ts attachmentDescriptor` emits `[post attached:
  <url>]` (the SDK decodes `postInfo.postUrl`; `kind === "post"`). Media still
  emits `[IMAGE attached, mediaKey: …]` for `view_media`.
- The model decides when to call it (it's a *server-side* tool, transparent to
  the agent loop — results come back as text/citations; `parseResponse` ignores
  the `custom_tool_call`/`web_search_call` output items). It's a **billed**
  tool (own Tools Pricing), public posts only, and a call takes ~10-30s.

## Media generation — `generate_image` / `generate_video`

`tools/xai-tools.ts` builds the request; `XaiMediaExecutor` calls the xAI
Imagine API (`/v1/images/*`, `/v1/videos/*`), saves results to
`/tmp/xchat-agent/`, and returns the path for `send_message`'s `media_path`.

### Editing — two flows, both keyed on a local file path

`source_image_url` must be a **local file path** or **http(s)/data URL** — never
a raw `mediaKey` (the handler rejects unknown forms with a
"call view_media first" message instead of 400ing).

1. **Edit a model-generated image:** `generate_image` already returned its path
   (`/tmp/xchat-agent/img_*`); pass that back as `source_image_url`. Works
   directly.
2. **Edit a USER-sent image:** the inbound annotation only carries a `mediaKey`,
   not a path. The model must call **`view_media` first** — it now **saves the
   download to `/tmp/xchat-agent/view_*` and returns that path** (see
   `ChatExecutor.viewMedia` → `saveMediaToTmp`) — then pass that path as
   `source_image_url`. The system prompt + tool/annotation text spell this out;
   without it the model passes the `mediaKey` and the edit fails.

**Aspect ratio on edits:** the API *preserves the source's proportions when you
omit `aspect_ratio` or pass `auto`* — it does NOT force square. Square outputs
came from the **model defaulting to `aspect_ratio:"1:1"`** (the prompt examples
used to lead with `1:1`). Fixed two ways: the handler defaults edits to `auto`
when the model omits the ratio, and the prompt/descriptions tell the model to
leave `aspect_ratio` unset on edits (only set it to deliberately change the
shape). An explicit `1:1` from the model still wins (real "make it square").

### Models (configurable, executor-stamped)

The handler **does not** set `model` — `XaiMediaExecutor` stamps it from
`XaiConfig` so model choice is one config, not scattered strings. Defaults track
the current flagships (verified live via `GET /v1/image-generation-models` and
`/v1/video-generation-models`):

| Config | Env override | Default | Notes |
|---|---|---|---|
| `imageModel` | `XAI_IMAGE_MODEL` | `grok-imagine-image-quality` | flagship; `grok-imagine-image` is the cheaper/faster tier (½ price). `…-pro` is a deprecated alias of quality. |
| `videoModel` | `XAI_VIDEO_MODEL` | `grok-imagine-video` | also `grok-imagine-video-1.5-preview` (image-only). |

### Parameter rules (verified against the live API enums)

- **Grok passes `""` (empty string), not `null`, for unused fields** (source
  urls, `aspect_ratio`, `resolution`, ref-url arrays). Treat empty/blank as
  *absent* (`present()` in `xai-tools.ts`), else the API 400s an empty image url
  / 422s an empty enum. First thing to check if media gen 400/422s.
- **Invalid `aspect_ratio`/`resolution` 422 (`unknown variant`).** The handler
  validates against per-endpoint allowlists and **drops** unknowns (`validParam`)
  rather than forwarding. Image and video accept **different** sets:
  - image `aspect_ratio`: `1:1 3:4 4:3 9:16 16:9 2:3 3:2 9:19.5 19.5:9 9:20 20:9 1:2 2:1 auto`; image `resolution`: **`1k` `2k`** (NOT 480p/720p).
  - video `aspect_ratio`: `1:1 16:9 9:16 4:3 3:4 3:2 2:3`; video `resolution`: `480p 720p 1080p`; `duration` 1–15s (bounded both ends). Video edit/extend ignore custom duration/aspect/resolution.
- **Honor the API's `mime_type`.** The quality model returns **PNG** for
  text-to-image but **JPEG** for edits. The executor saves with the extension
  matching `mime_type` (`extFromMime`) and threads it into `pendingMedia`,
  because `send_message` derives the upload content-type from the **file
  extension** — a PNG saved as `.jpg` uploads corrupt/rejected media.
- **Multi-image editing:** `/v1/images/edits` wants `image` as an **object**
  `{url,type}` for ONE source but an **array of bare strings** for 2–3. The
  `generate_image` tool exposes `additional_image_urls` for this (combine up to
  3 sources); the handler picks the shape by count.

### ZDR / video keys (the gotcha)

**Video generation requires a NON-ZDR `XAI_API_KEY`.** A ZDR key 400s
`"Zero Data Retention teams must provide output.upload_url for video
generation."`. **Image gen is fine on ZDR keys** (inline `b64_json`). ZDR is a
**team** property, not a key-ACL one — the heuristic "`endpoint:*` acls =
non-ZDR" is WRONG (the `x-web/.env` key has `endpoint:*`/`model:*` but its team
*is* ZDR, so video fails). Reliable signal: the **`api-key:flag:log-requests`**
ACL on `GET /v1/api-key` (present = logging/non-ZDR), or just try a video gen.

- The bot's prod key lives in the TSS material and is non-ZDR (team
  `xchat agent`, has `log-requests`).
- **For local video testing**, the `../x-web/.env` key is ZDR. Pull the non-ZDR
  bot key from TSS and export it instead:
  ```bash
  tss material dump xchat-agent/zw_bot/env | grep '^XAI_API_KEY=' | cut -d= -f2- # → export XAI_API_KEY=…
  ```

---

## Running in production (Kubernetes)

One StatefulSet per bot in your namespace (`$USER`), datacenter `atla`.
Image: `docker-releases-local.artifactory.twitter.biz/users/$USER/xchat-agent:<tag>`.
Auth + bootstrap (`DM_*`, `XAI_API_KEY`, `XCHAT_PIN`, `XCHAT_AGENT_CONFIG_B64`)
come from a **TSS material** `xchat-agent/<handle>/env` (see below) — **there is
no k8s Secret.** `/data` is an **emptyDir** (wiped on pod replacement, re-seeded
on next cold-start). External egress goes through an envoy sidecar
(`HTTPS_PROXY=http://127.0.0.1:3140`), enabled by the
`x.com/envoy-egress-sidecar-inject=true` label on the STS.

### Secrets / env — TSS (no k8s Secret)

The bot's entire env lives in one TSS material per bot:
**`xchat-agent/<handle>/env`** (owner `$USER`, admin group `xchat-admins`,
destination `compute-atla` (`kubernetes:config`), namespace `$USER`). The spec's
`twitterSecrets` mounts it read-only at `/var/lib/tss/keys/xchat-agent/<handle>/env`,
and the container entrypoint ([`deploy/agent/entrypoint.sh`](entrypoint.sh —
under deploy/agent/)) sources each `KEY=VALUE` line into the process env before
`exec`-ing the agent. **No fallback** — if the material isn't mounted, the pod
fails loudly (that's intentional; TSS is solid).

```bash
tss material describe xchat-agent/<handle>/env          # config + versions
tss material create -f ./env xchat-agent/<handle>/env   # push a new content version
# first-time (also sets owner / admin / k8s destination / namespace):
tss material create -o user $USER -a group xchat-admins \
  -d kubernetes compute-atla -n $USER -f ./env xchat-agent/<handle>/env
```

`deploy.sh` rebuilds this material on every deploy from
`~/.xchat/accounts/<handle>/` (`credentials.env` + `$XAI_API_KEY` + `$XCHAT_PIN`
+ `agent-config.json`). **TSS delivery can take up to ~30 min** to reach the
cluster — a restart that outruns delivery keeps sourcing the previous version
until the new one lands. (The one real tradeoff vs. the old instant-Secret path.)
To check what's actually on the pod: `kubectl … exec … -- ls /var/lib/tss/keys/xchat-agent/<handle>/`.

### 🔎 First: find which cluster the bot is on

xctl picks a cluster and appends a `--<slice>` suffix to the workload name, so
the StatefulSet is e.g. `xchat-agent-zw-bot--x6dls`. **The bot is NOT
necessarily on your default kube context** (e.g. `zw_bot` runs on
`atla-prod-swarm08` while the default context was `atla-prod-swarm03`).
`diag.sh`/`deploy.sh` run `kubectl` against the *current* context and will
silently report "no sts found" on the wrong cluster.

```bash
xctl workload pods -d atla -n $USER -w xchat-agent-zw-bot
# The CLUSTER column (e.g. atla-prod-swarm08) IS the kube context name:
kubectl --context atla-prod-swarm08 get sts -n $USER | grep xchat-agent
```

### Cold-start sequence (every pod boot)

0. The **entrypoint** sources `/var/lib/tss/keys/xchat-agent/<handle>/env` (the
   TSS material) into the env — `DM_*`, `XAI_API_KEY`, `XCHAT_PIN`, `XCHAT_AGENT_CONFIG_B64`.
1. `main.ts` creates `/data/.xchat/accounts/<handle>/`.
2. If `agent-config.json` is missing → decode `$XCHAT_AGENT_CONFIG_B64` and write it.
3. Open a fresh `dm.sqlite`, init schema.
4. If no `identity_keys` row → `Chat.account.recoverKeys($XCHAT_PIN)` (Juicebox).
5. `startLiveIngest()` opens the WebSocket through the egress proxy via
   `ProxiedWebSocket` (Bun's native `new WebSocket(url, { proxy })` is broken).
6. `inbox.sync()` ingests conv metadata + CKey rotation events + recent messages.
7. Watchers attach to each `allowedConversationIds`.

Result: a pod that comes back fully functional ~20s after a restart, no manual
state copy. Verify a healthy boot in logs: `seeded agent-config.json`,
`recovered N key version(s)`, `websocket: connected`, `listening on N
conversations`, and a `conversation_watch` per conv with `ckeyCount>=1`.

### Catch-up poll — socket-drop safety net

The WebSocket is not the only delivery path. `listenAndRespond`
(`adapters/xchat.ts`) also forks a **periodic catch-up poll**: every
`XCHAT_CATCH_UP_INTERVAL_MS` (default **600000 = 10 min**, `0` disables,
positive values clamped up to a **30s floor** so a misconfig can't hammer the
backend) it calls **`Chat.inbox.catchUp()`** — a delta pull from the bottom cursor
(`get_message_events_page` since the saved `max_user_sequence_id`, exposed in
the SDK at `api/domain/inbox.ts`, the same path the SDK runs on WS reconnect).

The key property: catch-up ingests through the **same pipeline** as live socket
frames, so newly-fetched messages fire the `messages:{convId}` PubSub that each
`watchConversation` stream is already subscribed to. The bot then handles them
through the **identical** permission → agent → send path — a recovered message
is processed exactly as if it had arrived over the socket. The watcher's
`lastSeenId` guard makes it idempotent: a message already delivered by the
socket is skipped, so it's **never answered twice**. This is what keeps the bot
responsive through backend WS-event SR brownouts (dropped frames are recovered
within the interval instead of lost). Look for `inbox_catch_up` log lines
(`success`, `durationMs`) to confirm it's running; the first one fires at
T+interval (boot already did a full `inbox.sync`).

### Deploying — pick the lightest path that fits

**(A) Config-only change** (allowlist / admins / toolkits / triggers). Edit
`~/.xchat/accounts/<handle>/agent-config.json`, push it into the TSS material
(it's base64'd into `XCHAT_AGENT_CONFIG_B64`), then restart so the new config
seeds (the restart is about TSS delivery, not watchers — on a live process,
editing the in-pod config file hot-applies everything via the reconcile loop,
including new conv ids):

```bash
CTX=atla-prod-swarm08   # discover via `xctl workload pods` (above)
STS=xchat-agent-zw-bot--<slice>
pnpm --filter @x-chat/xchat-agent deploy @zw_bot --skip-build   # rebuilds the TSS material
kubectl --context $CTX rollout restart sts/$STS -n $USER
```
**Heads-up:** TSS delivery lags up to ~30 min, so the restart may briefly source
the *old* config. For an urgent flip, `fs.watch` hot-reloads everything —
including `allowedConversationIds` via the watcher reconcile loop — if you edit
the in-pod `/data/.xchat/accounts/<handle>/agent-config.json` directly — but that's lost on
pod replacement, so always land it in TSS too.

**(B) Code change, image-only** (TSS material untouched → creds/PIN/whitelist/labels
preserved). The colima docker daemon here is **native linux/amd64**, so a plain
`docker build --platform linux/amd64` works — no buildx/buildah needed:

```bash
TAG="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
IMAGE="docker-releases-local.artifactory.twitter.biz/users/$USER/xchat-agent:$TAG"
docker build --platform linux/amd64 -t "$IMAGE" \
  -f apps/xchat-agent/deploy/agent/Dockerfile . && docker push "$IMAGE"
xctl workload deploy -d atla --namespace $USER --workload xchat-agent-zw-bot \
  --workload-spec-file apps/xchat-agent/deploy/agent/spec.yaml \
  --set handle=zw_bot --set safeHandle=zw-bot --image "$IMAGE" --replicas 1 --watch --yes
# confirm the new pod still has the envoy-egress sidecar; if the label got
# dropped, re-add it and delete the pod so the sidecar re-injects:
kubectl --context $CTX get sts $STS -n $USER \
  -o jsonpath='{.metadata.labels.x\.com/envoy-egress-sidecar-inject}'   # want: true
```

**(C) Full deploy (`deploy.sh`)** — rebuilds the TSS **env material**
`xchat-agent/<handle>/env` from local `credentials.env` + `$XAI_API_KEY` +
`$XCHAT_PIN` + `agent-config.json`, then builds+pushes, deploys, labels, waits.
Use for first-time setup or after rotating DM cookies. Requires `XAI_API_KEY` +
`XCHAT_PIN` in your env, and it runs `kubectl` against your **current context** —
switch to the bot's cluster first. Beware: if your local `credentials.env` is
stale this overwrites the live (good) cookies; and TSS delivery lags ~30 min.

```bash
export XAI_API_KEY=...   XCHAT_PIN=<bot pin>
pnpm --filter @x-chat/xchat-agent deploy @zw_bot              # build + push + deploy
pnpm --filter @x-chat/xchat-agent deploy @zw_bot --skip-build # reuse current image
```

### First-time setup (per machine, once per bot)

```bash
bun apps/xchat-cli/bin/cli.ts login @<handle> \
  --credentials "ct0=<...>; auth_token=<...>; twid=u%3D<USER_ID>"
bun apps/xchat-cli/bin/cli.ts -a @<handle> recover-keys "<PIN>"
# author ~/.xchat/accounts/<handle>/agent-config.json (schema above)
```

### Day-2 ops

```bash
CTX=atla-prod-swarm08; STS=xchat-agent-zw-bot--<slice>; POD=$STS-0
kubectl --context $CTX rollout restart sts/$STS -n $USER          # restart (wipes /data, ~20s)
kubectl --context $CTX logs -f $POD -n $USER -c main              # tail logs
kubectl --context $CTX exec -it $POD -c main -n $USER -- sh       # shell in (/data/.xchat/...)
pnpm --filter @x-chat/xchat-agent diag @zw_bot                    # health snapshot (uses current ctx!)
xctl workload delete -d atla -n $USER -w xchat-agent-zw-bot --force   # tear down
```

> `diag.sh`/`deploy.sh` use the **current** kube context. If the bot is on
> another cluster, either `kubectl config use-context <cluster>` first or use
> the explicit `kubectl --context` commands above.

### Voice (xAI Voice API)

| Direction | Tool | Endpoint | Notes |
|---|---|---|---|
| Speak (text→note) | `send_voice_note` | `POST /v1/tts` | voice `rex`; MP3 → `.m4a` via ffmpeg |
| Listen (note→text) | `view_media` on audio | `POST /v1/stt` | returns `{ text, … }` |

`/v1/tts` performs (doesn't speak) two kinds of expressive tags — **verified
live via a TTS→STT round-trip** (a performed tag is absent from the
transcription; a spoken one shows up): **inline** `[tag]` at a point (`[laugh]`,
`[sigh]`, `[pause]`, …) and **wrapping** `<tag>…</tag>` around words
(`<whisper>`, `<emphasis>`, `<singing>`, …). **The canonical, exhaustive tag set
is `src/tools/voice-tags.ts`** — a single source of truth that's injected into
both the system prompt's "Speaking" section and the `send_voice_note` description
(don't re-list tags elsewhere; edit that file). Two traps that bit the old
prompt:

1. **`<>` wrapping tags DO work** (an earlier note here claimed they were
   ignored — wrong; `<whisper>…</whisper>` is performed).
2. **Use the EXACT tag names.** A wrong form like `[laughs]` (plural) is a no-op
   (no laugh), and an invented tag like `[clears throat]`/`[flibbertigibbet]` is
   **read aloud**. So the model must be told the precise valid set (it is, in
   the system prompt's "Speaking" section + the `send_voice_note` description).

Change the voice via `voice_id` in `tools/executors/ChatExecutor.ts` (current:
`rex`; also `eve`/`ara`/`sal`/`leo`).

---

## Reading the logs

Every line is one JSON object (tee'd to stdout + `/data/.../logs/*.jsonl`).
Verbosity via `XCHAT_LOG_LEVEL` (default `Debug` = firehose; `Info`/`Warn` to
quiet the per-frame `sdk_log` lines).

| `type` | Fires when… | Use it to… |
|---|---|---|
| `health` | every 60s | confirm the bot is alive (WS state, per-conv counts) — was `type:"heartbeat"` before the drone's clock took the word |
| `heartbeat_wake` / `heartbeat_result` / `heartbeat_skipped` | clock wakes | what the drone did unprompted (digest size, tool calls, suppressed text, quiet-hours skips) |
| `brain_seeded` / `brain_write` / `brain_sync` / `brain_conflict` / `brain_push_failed` / `brain_read_failed` | brain activity | what it learned/committed; sync health; conflicts needing a human |
| `turn_context` | every brained turn | persona/memory size guardrail (context window is the real budget) |
| `websocket_state` | WS connect/reconnect/disconnect | catch silent socket drops |
| `message_received` | a msg arrives in an allowlisted conv | confirm WS delivery (socket **or** catch-up poll) |
| `inbox_catch_up` | every catch-up poll (default 10 min) | confirm the socket-drop safety net ran (`success`, `durationMs`) |
| `message_skipped` `reason="encrypted"` | got a msg, couldn't decrypt | **missing CKey** — admin must re-add the bot |
| `message_skipped` `reason="permission_denied"` | blocked by trigger/respondTo | tune `agent-config.json` |
| `permission_check` | every received message | see which rule allowed/denied |
| `tool_call` | a tool ran | name + args + result + success (logged twice — benign) |
| `agent_response` / `agent_error` | turn finished / failed | tokens, rounds, tool counts / errors (agent_error carries the messageId) |
| `xai_retry` | a model request 429/500'd and is being retried | provider churn per request; `final: true` = retry budget spent |
| `turn_retry` | a whole turn died and re-runs once in 45s | provider outage longer than in-request backoff |
| `message_sent` | a reply landed | confirm the bot actually sent |
| `config_reload` | `fs.watch` saw a config change | confirm hot-reload picked up edits |
| `watcher_reconcile` | allowlist change applied live | which conv watchers were added/removed without a restart |
| `sdk_log` | any xchat-sdk internal log | deep pipeline trace (below) |

`sdk_log` `annotations.pipeline` groups the deep trace: `frame` (inbound WS
frames + drops), `ingest` (decode→verify→decrypt), `ckey` (key resolution;
`result:"unavailable"` = bot can't read the conv), `sign` (outbound signing),
`send` (outbound lifecycle). Follow one outbound msg:
`kubectl ... logs -f $POD -c main | grep -E '"pipeline":"(send|sign)"'`.

---

## Hard-won lessons / gotchas

- **The bot is NOT on your default kube context.** Find it with `xctl workload
  pods`; the `CLUSTER` column is the context name. (Biggest time-sink.)
- **Colon vs dash conversation ids** — see the trap above. Dash = silent death.
- **xAI `/v1/responses` 500s** are payload-shape-driven, not load. See "Model
  layer". `store: true` doesn't help (404/ZDR). Retry is the real fix.
- **Bun's WebSocket-with-proxy is broken** — `new WebSocket(url,{proxy})` never
  opens, and Bun shims `ws` with the same broken native impl. We ship
  `packages/xchat-sdk/src/bun/proxied-websocket.ts` (TCP CONNECT + node:tls +
  manual RFC 6455). Auto-activates when `$HTTPS_PROXY`/`$HTTP_PROXY` is set.
- **CKeys only deliver on a membership change.** Adding the bot to an *existing*
  group doesn't re-key, so it lands unable to decrypt. Fix: an admin removes +
  re-adds the bot (triggers a fresh CKCE).
- **Cold-start regenerates state, never copies it.** `kubectl cp dm.sqlite`
  races Bun's open handle. Identity keys (~1KB) come back via Juicebox + the
  PIN; everything else is rebuilt from the API via `inbox.sync()`.
- **xctl silently ignores `volumeClaimTemplates`** → no real PVC, hence
  `emptyDir` + cold-start regeneration.
- `chat-ws.x.com` is already covered by the `*.x.com:443` egress ACL — a 503 on
  a plain GET to it is normal (it's WS-only); the real proxy issue was Bun.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `kubectl`/`diag` says "no sts found" | wrong kube context | `xctl workload pods -d atla -n $USER -w xchat-agent-zw-bot`, use that cluster's `--context` |
| Bot silently never replies in a conv | dash-form conv id in allowlist | use the colon form (`a:b`), restart |
| `send_message` → "not in the allowlist" | model used a non-colon / wrong id | normalize to the stored colon id |
| Bot "ignores" some messages | xAI 500 dropped the turn | now retried; check `agent_error` for `xAI 500: …` body |
| `permission_denied` on a 1:1 | `trigger: mention_only` default | per-conv `{"trigger":"all_messages"}` |
| WS connected but no `message_received` for a group | bot has no CKey | admin remove + re-add the bot |
| Pod `ImagePullBackOff` on a `<ts>-<sha>` tag | a `--skip-build`/`--tag` pointed at an unpushed image | redeploy without `--skip-build` |
| Image push: `User is unauthorized` | `docker login` only covers one host | copy the auth entry for both `*.twitter.biz`/`*.local.twitter.com` in `~/.docker/config.json` |
| New pod missing `envoy-egress` sidecar | egress label dropped on deploy | re-add `x.com/envoy-egress-sidecar-inject=true`, delete the pod |
| `recovery failed` in logs | wrong PIN or Juicebox unreachable | verify PIN; egress must allow `realm-*.x.com:443` |
