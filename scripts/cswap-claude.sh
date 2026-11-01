#!/bin/sh
# Claude Code executable for multi-account routes: run as the cswap account
# Bridge chose. cswap keeps stdout clean, so the SDK stream is unaffected.
set -eu
: "${BRIDGE_CSWAP_ACCOUNT:?BRIDGE_CSWAP_ACCOUNT is not set}"
PRIVATE="${HOME:-}/.local/share/factory-cc-runtimes/cswap/cswap"
if [ -z "${BRIDGE_CSWAP_EXECUTABLE:-}" ] && [ -x "$PRIVATE" ]; then BRIDGE_CSWAP_EXECUTABLE="$PRIVATE"; fi
exec "${BRIDGE_CSWAP_EXECUTABLE:-cswap}" run "$BRIDGE_CSWAP_ACCOUNT" --share-history -- "$@"
