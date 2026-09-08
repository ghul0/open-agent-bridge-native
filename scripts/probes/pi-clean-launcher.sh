#!/usr/bin/env bash
set -euo pipefail

readonly CLEAN_ROOT="${NAB_PI_CLEAN_ROOT:-$HOME/.local/share/native-agent-broker/pi-clean}"
readonly AGENT_DIR="$CLEAN_ROOT/agent"
readonly PI_BIN="$CLEAN_ROOT/node_modules/.bin/pi"
readonly EXTENSION="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/src/native/pi-nab-extension.ts"
readonly MANAGED_AUTH="${NAB_PI_AUTH_FILE:-$HOME/.pi/agent/auth.json}"

if [[ ! -x "$PI_BIN" ]]; then
  printf 'Clean Pi is missing at %s (expected @earendil-works/pi-coding-agent 0.85.1)\n' "$PI_BIN" >&2
  exit 1
fi
mkdir -p "$AGENT_DIR" "$CLEAN_ROOT/sessions"
chmod 700 "$CLEAN_ROOT" "$AGENT_DIR" "$CLEAN_ROOT/sessions"
if [[ -f "$MANAGED_AUTH" && ! -e "$AGENT_DIR/auth.json" ]]; then
  ln -s "$MANAGED_AUTH" "$AGENT_DIR/auth.json"
fi

export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$CLEAN_ROOT/sessions"
export NODE_PATH="$CLEAN_ROOT/node_modules${NODE_PATH:+:$NODE_PATH}"
exec "$PI_BIN" --extension "$EXTENSION" "$@"
