#!/usr/bin/env bash
# Self-redeploy for the harness product agent.
# Safe order: start NEW process → wait until healthy → kill OLD.
# Usage: restart.sh [handle] [parent_pid]
set -uo pipefail  # no -e: never abort after kill before start

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HANDLE="${1:-tatanbotter09}"
PARENT_PID="${2:-${XCHAT_PARENT_PID:-}}"
LOG=/tmp/xchat-restart.log
PIDFILE=/tmp/xchat-agent.pid
SESSION=xchat-agent
export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

exec >>"$LOG" 2>&1
echo ""
echo "========== [$(date)] restart begin =========="
echo "root=$ROOT handle=$HANDLE parent=${PARENT_PID:-none}"

cd "$ROOT" || {
  echo "FATAL: cannot cd $ROOT"
  exit 1
}

bash scripts/setup-sdk-links.sh || echo "warn: setup-sdk-links failed"
git pull --ff-only origin main 2>/dev/null || git pull origin main 2>/dev/null || git pull || echo "warn: git pull failed"
if command -v pnpm >/dev/null; then
  pnpm install || echo "warn: pnpm install failed"
else
  bun install || echo "warn: bun install failed"
fi

# Load secrets for child process environment
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
  echo "env: loaded $ROOT/.env keys=$(grep -E '^[A-Z_]+=' "$ROOT/.env" | cut -d= -f1 | tr '\n' ' ')"
fi

start_agent() {
  local cmd="cd '$ROOT' && exec bun run apps/agent/bin/main.ts --as $HANDLE"
  if command -v tmux >/dev/null 2>&1; then
    # Use a fresh session name, then rename — avoids killing ourselves mid-start.
    local tmp="xchat-agent-boot-$$"
    tmux kill-session -t "$tmp" 2>/dev/null || true
    tmux new -d -s "$tmp" -c "$ROOT" "$cmd"
    # Give bun a moment to spawn
    sleep 2
    if ! tmux has-session -t "$tmp" 2>/dev/null; then
      echo "FATAL: tmux session $tmp died immediately"
      return 1
    fi
    # Swap: kill old session, rename new → canonical
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    tmux rename-session -t "$tmp" "$SESSION" 2>/dev/null || true
    echo "started tmux session=$SESSION"
    return 0
  fi

  nohup bun run apps/agent/bin/main.ts --as "$HANDLE" >>"$LOG" 2>&1 &
  local newpid=$!
  echo "$newpid" >"$PIDFILE"
  sleep 2
  if ! kill -0 "$newpid" 2>/dev/null; then
    echo "FATAL: nohup agent pid=$newpid died immediately"
    return 1
  fi
  echo "started nohup pid=$newpid"
  return 0
}

if ! start_agent; then
  echo "FATAL: failed to start replacement agent — old process left alone if still running"
  exit 1
fi

# Wait for healthy boot signals in a log file NEWER than this restart.
AGENT_LOG_DIR="${HOME}/.xchat/accounts/${HANDLE}/logs"
BOOT_EPOCH=$(date +%s)
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  latest=$(ls -t "$AGENT_LOG_DIR"/agent-*.jsonl 2>/dev/null | head -1 || true)
  if [ -n "${latest:-}" ]; then
    # macOS stat
    log_epoch=$(stat -f %m "$latest" 2>/dev/null || stat -c %Y "$latest" 2>/dev/null || echo 0)
    if [ "$log_epoch" -ge $((BOOT_EPOCH - 2)) ] \
      && grep -q '"type":"websocket_state".*"connected"\|"state":"connected"' "$latest" 2>/dev/null; then
      echo "health: websocket connected (log=$(basename "$latest"))"
      break
    fi
  fi
  if ! tmux has-session -t "$SESSION" 2>/dev/null \
    && { [ ! -f "$PIDFILE" ] || ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }; then
    echo "warn: agent process not found while waiting for health"
  fi
  sleep 1
done

# Kill the process that invoked restart (foreground agent), if still alive
if [ -n "${PARENT_PID}" ] && kill -0 "$PARENT_PID" 2>/dev/null; then
  echo "killing parent pid=$PARENT_PID"
  kill "$PARENT_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$PARENT_PID" 2>/dev/null || true
fi

# Stale pidfile from older nohup runs
if [ -f "$PIDFILE" ]; then
  old=$(cat "$PIDFILE" || true)
  if [ -n "${old:-}" ] && [ "${old}" != "${PARENT_PID:-}" ] && kill -0 "$old" 2>/dev/null; then
    # only kill if it's an old agent and we're on tmux now (replacement is tmux)
    if command -v tmux >/dev/null && tmux has-session -t "$SESSION" 2>/dev/null; then
      if [ "$old" != "$$" ]; then
        echo "killing stale pidfile pid=$old"
        kill "$old" 2>/dev/null || true
      fi
    fi
  fi
fi

echo "[$(date)] restart done sha=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "attach: tmux attach -t $SESSION"
echo "logs:   tail -f $LOG"
echo "agent:  ls -t $AGENT_LOG_DIR | head"
