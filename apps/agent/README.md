# xchat-agent

An X account whose DMs are watched and answered by **Grok**. A long-running autonomous bot that listens to an account's encrypted conversations, decides when to reply, and responds with text, images, video, or voice — built on [`@x-chat/xchat-sdk`](../../packages/xchat-sdk/README.md).

One process per bot account. Runs locally on [Bun](https://bun.sh) for development; in production each bot is a self-recovering Kubernetes StatefulSet.

## What it can do

- **Hold conversations** in 1:1s and groups, with per-conversation rules for who it answers and when (every message vs. only when @mentioned).
- **See and make media** — view images/video users send, and generate or edit images and video via the xAI Imagine API.
- **Speak and listen** — send voice notes (text-to-speech with expressive tags) and transcribe voice notes it receives.
- **Read shared X posts** — follows a shared post's whole thread, including its images and video, via xAI's server-side `x_search` tool.
- **Run skills and tools** — gated per conversation and per user; admins can unlock a coding toolkit (`bash`, `bun_run`).

Capabilities are grouped into **toolkits** you grant per conversation:

| Toolkit | Tools |
|---|---|
| `xchat` | `send_message`, `react_to_message`, `view_media`, `send_voice_note`, `search_messages`, `search_conversations`, `get_conversation_info` |
| `xai` | `generate_image`, `generate_video` |
| `coding` | `bash`, `bun_run` — powerful, admins only |
| `core` | `use_skill` — always on |

## Run one locally

The bot talks over the real X DM backend, so the natural test is to drive it from a **second** account (e.g. via the [CLI](../xchat-cli/README.md)).

```bash
# 1. Log the bot in and recover its encryption keys (needs its Juicebox PIN)
bun apps/xchat-cli/bin/cli.ts login @botHandle --credentials "ct0=...; auth_token=..."
bun apps/xchat-cli/bin/cli.ts -a @botHandle recover-keys "<PIN>"

# 2. Write ~/.xchat/accounts/<botHandle>/agent-config.json (see below)

# 3. Boot the bot
export XAI_API_KEY=...        # an xAI key (video gen requires a non-ZDR key)
export XAI_MODEL=grok-4.3
bun apps/xchat-agent/bin/main.ts --as botHandle

# 4. From the other account, message the bot and watch it reply
bun apps/xchat-cli/bin/cli.ts -a @driver send <conv-id> "hey"
```

Running `bun apps/xchat-agent/bin/main.ts` with no `--as` starts a stdin-only REPL (no SDK/DM deps) for quick model sanity checks.

## Configuration — `agent-config.json`

Lives at `~/.xchat/accounts/<handle>/agent-config.json`. It controls which conversations are watched and how the bot behaves in each. `defaults`, `conversations`, `admins`, and `toolkits` hot-reload on a running bot; adding a brand-new conversation id needs a restart.

```jsonc
{
  "botHandles": ["<handle>"],                 // used to detect @mentions
  "globalAdmins": ["<x-user-id>"],            // get globalAdminToolkits everywhere
  "globalAdminToolkits": ["xchat", "xai", "coding", "core"],
  "allowedConversationIds": ["<convId>"],     // ONLY these are watched
  "defaults": { "respondTo": "everyone", "trigger": "mention_only",
                "toolkits": ["xchat", "xai"] },
  "conversations": {                          // per-conversation overrides
    "<convId>": { "trigger": "all_messages", "toolkits": ["xchat", "xai"] }
  }
}
```

- `respondTo`: `"everyone"` | `"admins_only"`
- `trigger`: `"all_messages"` | `"mention_only"` (1:1s usually want `all_messages`)
- `toolkits`: a `string[]` or `{ "admin": string[], "user": string[] }`

> ⚠️ **Conversation ids use a colon.** 1:1 ids are `<lowerUserId>:<higherUserId>` (groups are `g<id>`). That colon form is what's stored and streamed — the dash form some SDK paths build will silently never match. Always allowlist the colon id. See [`AGENTS.md`](AGENTS.md) for the gory details.

## How it stays alive

On every boot the bot rebuilds its own state — it recovers identity keys from Juicebox (using its PIN), opens a fresh SQLite DB, syncs the inbox, and attaches a watcher per allowed conversation. Nothing is copied between runs, so a restarted pod is fully functional in ~20s. A periodic **catch-up poll** backstops the WebSocket: if frames are dropped, the next poll recovers them through the same pipeline, and a per-conversation `lastSeenId` guard guarantees no message is answered twice.

The model runs through a custom xAI Responses-API provider (`src/XaiLanguageModel.ts`) with retry/backoff on transient 5xx. Every action is logged as one JSON object per line (`message_received`, `permission_check`, `tool_call`, `agent_response`, `message_sent`, …).

## Layout

```
bin/main.ts            Entry point — boots the SDK, recovers keys, starts adapters
src/Agent.ts           The agent loop (model ↔ tool calls), context pruning
src/adapters/          stdin (interactive) + xchat (the DM watcher)
src/config.ts          agent-config.json loader + hot-reload
src/tools/             Tool definitions + executors (xchat, xai media, voice, skills)
src/XaiLanguageModel.ts  Custom xAI /v1/responses provider
src/skills.ts          Discovers skills/ (local + repo-level)
deploy/agent/          Dockerfile, entrypoint, k8s spec, deploy.sh, diag.sh
evals/                 Behavioral eval cases + runner
```

## Develop & deploy

```bash
pnpm --filter @x-chat/xchat-agent test        # bun test
pnpm --filter @x-chat/xchat-agent typecheck
pnpm --filter @x-chat/xchat-agent eval         # behavioral evals
pnpm --filter @x-chat/xchat-agent deploy @<handle>   # build + push + deploy to k8s
pnpm --filter @x-chat/xchat-agent diag @<handle>     # production health snapshot
```

**No `try`/`catch` — ever.** Error handling stays in the Effect channel. Production runs on Kubernetes with secrets delivered via TSS (no k8s Secret) and egress through an envoy sidecar. The full ops runbook — deploy paths, cold-start sequence, log reference, and every hard-won gotcha — is in [`AGENTS.md`](AGENTS.md). Read it before touching the deploy.
