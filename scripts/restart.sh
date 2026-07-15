#!/usr/bin/env bash
# Self-redeploy for the harness product agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLE="${1:-tatanbotter09}"
LOG=/tmp/xchat-restart.log
PIDFILE=/tmp/xchat-agent.pid
export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:${PATH}"
exec >>"$LOG" 2>&1
echo "[$(date)] harness restart root=$ROOT handle=$HANDLE"
cd "$ROOT"
bash scripts/setup-sdk-links.sh || true
git pull --ff-only || git pull || true
if command -v pnpm >/dev/null; then pnpm install || true; else bun install || true; fi
if [ -f "$ROOT/.env" ]; then set -a; source "$ROOT/.env"; set +a; fi
if [ -z "${XAI_API_KEY:-}" ] && [ -f "$ROOT/../x-chat/.env" ]; then
  set -a; source "$ROOT/../x-chat/.env"; set +a
fi

# stop previous
if command -v tmux >/dev/null; then
  tmux kill-session -t xchat-agent 2>/dev/null || true
fi
if [ -f "$PIDFILE" ]; then
  old=$(cat "$PIDFILE" || true)
  if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 1
    kill -9 "$old" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

if command -v tmux >/dev/null; then
  tmux new -d -s xchat-agent -c "$ROOT" \
    "bun run apps/agent/bin/main.ts --as $HANDLE"
  echo "[$(date)] tmux session xchat-agent started"
else
  nohup bun run apps/agent/bin/main.ts --as "$HANDLE" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  echo "[$(date)] nohup pid=$(cat "$PIDFILE")"
fi
echo "[$(date)] done sha=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
