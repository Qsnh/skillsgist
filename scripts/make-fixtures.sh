#!/usr/bin/env bash
# Build real test fixtures with the system tar/zip, so the readers face real-world bytes rather than our own output.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=test/fixtures
rm -rf "$OUT" && mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/flat/references" "$TMP/flat/scripts"
cat > "$TMP/flat/SKILL.md" <<'MD'
---
name: demo-skill
description: A demo skill used by the test suite.
---

# Demo

Body text.
MD
echo '# API notes' > "$TMP/flat/references/api.md"
echo 'echo hi' > "$TMP/flat/scripts/run.sh"

# tar packs "." — entries carry a ./ prefix, exactly the real case that needs stripping
# --no-xattrs/--no-mac-metadata/--no-acls/--no-fflags: recent macOS stamps every
# file with extended attributes like com.apple.provenance, and bsdtar encodes
# them into extra PaxHeader/* entries by default. COPYFILE_DISABLE only blocks
# AppleDouble (._*) files, not these, so xattr archiving must be turned off
# explicitly.
#
# `tar czf` has bsdtar compress internally, which block-aligns the output (10240
# bytes) and pads with zeros after the real gzip stream ends. workerd's native
# DecompressionStream("gzip") has zero tolerance for those trailing bytes and
# throws "Trailing bytes after end of compressed data" (Node's zlib and the gzip
# command both ignore them silently, which is why verifying locally with gzip -t
# or zlib finds nothing). Having tar only pack and piping to a separate gzip
# produces a clean single gzip stream with no block alignment involved.
TAR_NO_META=(--no-xattrs --no-mac-metadata --no-acls --no-fflags)
( cd "$TMP/flat" && COPYFILE_DISABLE=1 tar cf - "${TAR_NO_META[@]}" . | gzip -n ) > "$OUT/flat-dot.tar.gz"

# bsdtar's real default: `tar czf` has tar compress internally, block-aligning
# the output (10240 bytes) and padding with zeros after the real gzip stream
# ends. These are the bytes a macOS user gets from the most ordinary
# `tar czf skill.tar.gz .`, and the reader has to tolerate that padding rather
# than dodge it in a fixture. Entries stay as clean as flat-dot.tar.gz (same
# --no-xattrs and friends), so compression is the only variable and both
# production methods get coverage.
( cd "$TMP/flat" && COPYFILE_DISABLE=1 tar czf - "${TAR_NO_META[@]}" . ) > "$OUT/bsdtar-padded.tar.gz"

# A zip with an outer wrapper directory — the shape GitHub archive downloads have
mkdir -p "$TMP/wrap" && cp -R "$TMP/flat" "$TMP/wrap/demo-skill"
( cd "$TMP/wrap" && zip -q -r - demo-skill ) > "$OUT/wrapped.zip"

# A zip with SKILL.md at the root
( cd "$TMP/flat" && zip -q -r - . ) > "$OUT/flat.zip"

# A zip with no SKILL.md
mkdir -p "$TMP/bad" && echo 'nope' > "$TMP/bad/README.md"
( cd "$TMP/bad" && zip -q -r - . ) > "$OUT/no-skill-md.zip"

# A tar.gz containing a symlink
mkdir -p "$TMP/link" && cp "$TMP/flat/SKILL.md" "$TMP/link/SKILL.md"
ln -s /etc/passwd "$TMP/link/evil"
( cd "$TMP/link" && COPYFILE_DISABLE=1 tar cf - "${TAR_NO_META[@]}" . | gzip -n ) > "$OUT/symlink.tar.gz"

ls -l "$OUT"
