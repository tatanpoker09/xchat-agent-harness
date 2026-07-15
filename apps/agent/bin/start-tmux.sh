#!/usr/bin/env bash
set -euo pipefail

SESSION="xchat-agent"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# Strip leading "--" that pnpm injects when forwarding args
while [ "${1:-}" = "--" ]; do shift; done

if [ $# -eq 0 ]; then
  echo "Usage: $0 --as <handle> [--model <model>]"
  exit 1
fi

# Kill existing session if present
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Build the bun command with all passed args
CMD="bun run --cwd apps/xchat-agent bin/main.ts $*"

echo "Starting tmux session '$SESSION'..."
echo "  repo: $REPO_DIR"
echo "  cmd:  $CMD"

tmux new -d -s "$SESSION" -c "$REPO_DIR" "$CMD"

echo "Started. Attach with: tmux attach -t $SESSION"
