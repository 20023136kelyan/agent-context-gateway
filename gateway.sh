#!/bin/sh
# gateway.sh — stable entrypoint for launchd/hooks (resolves nvm node).
set -e
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
GATEWAY_DIR="$(cd "$(dirname "$0")" && pwd)"
# `--import tsx` resolves from the CURRENT directory, and hooks run in the
# user's project, where tsx is not installed: every hook invoked from another
# project failed with ERR_MODULE_NOT_FOUND. Resolve the loader from the
# gateway instead (an encoded file:// URL, so paths with spaces work).
TSX_LOADER="$(cd "$GATEWAY_DIR" && node --input-type=module -e "console.log(import.meta.resolve('tsx'))")"
# --env-file-if-exists so launchd and hooks pick up .env too; they get none of
# the interactive shell's environment.
exec node --env-file-if-exists="$GATEWAY_DIR/.env" --import "$TSX_LOADER" "$GATEWAY_DIR/src/cli.ts" "$@"
