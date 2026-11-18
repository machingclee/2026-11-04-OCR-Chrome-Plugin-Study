#!/usr/bin/env bash
#
# Pack the built extension in dist/ into a Chrome-loadable zip.
#
#   ./scripts/zip-dist.sh             -> dist.zip in the repo root
#   npm run zip                       -> the same
#   ./scripts/zip-dist.sh /tmp/x.zip  -> a specific output path
#
# The archive holds the *contents* of dist/ at its root, not a dist/ folder, so
# manifest.json lands at the top level. That is what the Chrome Web Store
# upload takes and what "Load unpacked" expects after unzipping; an archive
# with everything under a dist/ prefix is rejected as missing a manifest.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname -- "$SCRIPT_DIR")"
DIST="$ROOT/dist"
MANIFEST="$DIST/manifest.json"

if [[ $# -gt 1 ]]; then
  echo "error: expected at most one argument (output zip path)" >&2
  echo "usage: $(basename -- "$0") [output.zip]" >&2
  exit 64
fi

if [[ ! -d "$DIST" ]]; then
  echo "error: dist/ does not exist - run 'npm run build' first" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "error: dist/manifest.json is missing - the build looks incomplete, rerun 'npm run build'" >&2
  exit 1
fi

if [[ -z "$(find "$DIST" -type f -print -quit)" ]]; then
  echo "error: dist/ is empty - run 'npm run build' first" >&2
  exit 1
fi

# Resolve the output path now that the working directory is still stable.
if [[ -n "${1:-}" ]]; then
  OUT="$1"
else
  OUT="$ROOT/dist.zip"
fi

OUT_DIR="$(dirname -- "$OUT")"
mkdir -p -- "$OUT_DIR"
OUT="$(cd -- "$OUT_DIR" && pwd)/$(basename -- "$OUT")"

case "$OUT" in
  "$DIST"/*)
    echo "error: refusing to write the zip inside dist/ ($OUT)" >&2
    exit 1
    ;;
esac

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed (macOS and most Linux distros ship it)" >&2
  exit 1
fi
if ! command -v unzip >/dev/null 2>&1; then
  echo "error: 'unzip' is not installed, and it is needed to verify the archive" >&2
  exit 1
fi

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1)"
VERSION="${VERSION:-unknown}"

# A stale dist/ makes a zip that quietly ships old code. Warn, do not fail:
# packing an existing build is a legitimate thing to want.
STALE="$(find "$ROOT/src" "$ROOT/public" -type f -newer "$MANIFEST" -print -quit 2>/dev/null || true)"
if [[ -n "$STALE" ]]; then
  echo "warning: dist/ is older than ${STALE#"$ROOT"/} - run 'npm run build' to refresh it" >&2
fi

rm -f -- "$OUT"

# -X drops uid/gid and other extra attributes, so the same inputs give a
# similar archive on any machine. No -9: the models are 196 MB of mostly
# incompressible weights and maximum compression only costs time.
(
  cd -- "$DIST"
  zip -r -q -X "$OUT" . -x '*.DS_Store' '*__MACOSX*' '*.map'
)

LIST="$(unzip -Z1 "$OUT")"

if ! grep -qx <<<"$LIST" 'manifest.json'; then
  echo "error: manifest.json is not at the root of $OUT - the archive is not loadable" >&2
  rm -f -- "$OUT"
  exit 1
fi

ENTRIES="$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"
FILES="$(printf '%s\n' "$LIST" | awk '!/\/$/' | wc -l | tr -d ' ')"
SIZE="$(du -h "$OUT" | cut -f 1)"

echo "packed Comic Translator $VERSION"
echo "  archive: $OUT"
echo "  files:   $FILES"
echo "  entries: $ENTRIES (files plus directories)"
echo "  size:    $SIZE"
