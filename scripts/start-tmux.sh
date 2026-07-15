#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLE="${1:-tatanbotter09}"
export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:${PATH}"
cd "$ROOT"
if [ -f "$ROOT/.env" ]; then set -a; source "$ROOT/.env"; set +a; fi
if [ -z "${XAI_API_KEY:-}" ] && [ -f "$ROOT/../x-chat/.env" ]; then
  set -a; source "$ROOT/../x-chat/.env"; set +a
fi
exec tmux new-session -A -s xchat-agent \
  "cd '$ROOT' && exec bun run apps/agent/bin/main.ts --as $HANDLE"
