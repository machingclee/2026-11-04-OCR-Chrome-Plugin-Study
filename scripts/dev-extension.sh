#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
PROFILE="${COMIC_TRANSLATOR_PROFILE:-/tmp/comic-translator-dev-profile}"
PORT="${COMIC_TRANSLATOR_DEBUG_PORT:-9222}"

CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"
if [ ! -x "$CHROME_BIN" ]; then
    CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
if [ ! -x "$CHROME_BIN" ]; then
    echo "Chrome not found. Set CHROME_BIN to the Chrome executable." >&2
    exit 1
fi

cd "$ROOT"
npm run build

pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 1

exec "$CHROME_BIN" \
    --user-data-dir="$PROFILE" \
    --disable-extensions-except="$DIST" \
    --load-extension="$DIST" \
    --remote-debugging-port="$PORT" \
    --no-first-run \
    --no-default-browser-check \
    "$@"
