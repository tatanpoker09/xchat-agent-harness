# xchat-agent-harness

**Skills / extras sidecar** for `@tatanbotter09` — NOT the agent runtime.

| Put here | Do NOT put here |
|----------|-----------------|
| `*/SKILL.md` skills | Message handling / adapters |
| Linear CLI skill | Agent loop / restart logic |
| Small agent extensions docs | Full xchat-agent rewrites |

Runtime code lives in the local **x-chat** checkout:
`apps/xchat-agent/**` (upstream `x-clients/x-chat`).

On `restart_agent`, skills from this repo are copied into
`apps/xchat-agent/skills/`.
