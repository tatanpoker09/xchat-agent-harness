#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XCHAT_ROOT="${XCHAT_ROOT:-}"
if [ -z "$XCHAT_ROOT" ]; then
  if [ -d "$ROOT/../x-chat/packages/xchat-sdk" ]; then
    XCHAT_ROOT="$(cd "$ROOT/../x-chat" && pwd)"
  fi
fi
if [ -z "${XCHAT_ROOT}" ] || [ ! -d "$XCHAT_ROOT/packages/xchat-sdk" ]; then
  echo "Set XCHAT_ROOT to your x-chat checkout (need packages/xchat-sdk + drone-core)." >&2
  exit 1
fi
mkdir -p "$ROOT/packages"
ln -sfn "$XCHAT_ROOT/packages/xchat-sdk" "$ROOT/packages/xchat-sdk"
ln -sfn "$XCHAT_ROOT/packages/drone-core" "$ROOT/packages/drone-core"
echo "SDK linked from $XCHAT_ROOT"
ls -la "$ROOT/packages"
