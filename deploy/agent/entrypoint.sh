#!/usr/bin/env bash
# Container entrypoint — source TSS material, then start harness agent.
set -eu

HANDLE="${XCHAT_ACCOUNT_HANDLE:?XCHAT_ACCOUNT_HANDLE required}"
ENV_FILE="/var/lib/tss/keys/xchat-agent/${HANDLE}/env"

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: TSS material not mounted at ${ENV_FILE}." >&2
  echo "       Expect material xchat-agent/${HANDLE}/env delivered to this cluster." >&2
  exit 1
fi

while IFS='=' read -r key val || [ -n "${key:-}" ]; do
  case "$key" in
    ''|\#*) continue ;;
  esac
  export "${key}=${val}" 2>/dev/null || true
done < "$ENV_FILE"

missing=""
for v in DM_BEARER_TOKEN DM_CSRF_TOKEN DM_USER_ID XAI_API_KEY XCHAT_PIN XCHAT_AGENT_CONFIG_B64; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="${missing} ${v}"
done
if [ -n "$missing" ]; then
  echo "FATAL: TSS material ${ENV_FILE} missing required key(s):${missing}" >&2
  exit 1
fi

# Optional: LINEAR_API_KEY, SOURCEGRAPH_TOKEN, BRAIN_GIT_TOKEN — nice-to-have.

export PATH="/app/bin:${PATH:-}"
export HOME="${HOME:-/data}"

echo "starting harness agent as @${HANDLE}"
exec bun run apps/agent/bin/main.ts --as "$HANDLE"
