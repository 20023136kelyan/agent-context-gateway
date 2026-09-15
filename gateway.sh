#!/bin/sh
# gateway.sh — stable entrypoint for launchd/hooks (resolves nvm node).
set -e
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
GATEWAY_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node --import tsx "$GATEWAY_DIR/src/cli.ts" "$@"
