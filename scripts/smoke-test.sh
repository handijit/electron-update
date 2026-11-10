#!/bin/sh
# Installs the packed tarball into an empty project and uses it the way a consumer does.
# The tests measure the source; this measures the tarball a consumer installs.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/node_modules/.bin"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
TARBALL="$ROOT/$(npm pack --silent --pack-destination "$WORK" | tail -n 1)"
TARBALL="$WORK/$(basename "$TARBALL")"

# The tarball holds the six entries in both formats with their types, the stylesheet, and
# nothing else.
tar -tzf "$TARBALL" | sort > "$WORK/files.txt"
node "$ROOT/scripts/smoke/tarball.mjs" "$WORK/files.txt"

mkdir "$WORK/consumer"
cp "$ROOT"/scripts/smoke/* "$WORK/consumer/"
cd "$WORK/consumer"
npm init -y >/dev/null
# npm installs the required peers (electron, electron-updater, @handijit/electron,
# @handijit/core, zod) next to the tarball. The optional ones are named, as a program with a
# React page names them. Without install scripts the Electron binary is not downloaded:
# these checks need its types only. @types/semver is for electron-updater: its declarations
# import semver, and the consumers below check library declarations too (skipLibCheck: false).
npm install --ignore-scripts --no-audit --no-fund "$TARBALL" \
  react react-dom @handijit/ui @types/react @types/node @types/semver >/dev/null

node esm.mjs
node cjs.cjs
# One consumer, three resolutions: a bundler, Node's CommonJS (the .d.ts files) and Node's ES
# modules (the .d.mts files). The components (consumer-ui.ts) are checked by the bundler
# resolution only, which is how a page is compiled.
cp consumer.ts consumer.mts
"$BIN/tsc" -p tsconfig.bundler.json
"$BIN/tsc" -p tsconfig.node.json
echo "TypeScript consumers OK"
