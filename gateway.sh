#!/bin/sh
# gateway.sh — stable entrypoint for launchd/hooks (resolves nvm node).
set -e
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
GATEWAY_DIR="$(cd "$(dirname "$0")" && pwd)"
# --env-file-if-exists so launchd and git hooks pick up .env too; they get
# none of the interactive shell's environment.
exec node --env-file-if-exists="$GATEWAY_DIR/.env" --import tsx "$GATEWAY_DIR/src/cli.ts" "$@"
