#!/usr/bin/env bash
# 用系统 tar/zip 生成真实的测试数据，确保读取器面对的是真实世界的字节而非我们自己的输出。
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

# tar 打包 "." —— 条目会带 ./ 前缀，这正是需要被清洗掉的真实场景
# --no-xattrs/--no-mac-metadata/--no-acls/--no-fflags：新版 macOS 会给每个文件打
# com.apple.provenance 之类的扩展属性，bsdtar 默认会把它们编码成额外的 pax
# PaxHeader/* 条目混进归档。COPYFILE_DISABLE 只挡得住 AppleDouble（._*）文件，
# 挡不住这个，必须显式关掉扩展属性归档。
#
# `tar czf` 让 bsdtar 自己内部压缩，它会把输出按块（10240 字节）对齐，在真正的
# gzip 流结束后补零填充。workerd 的原生 DecompressionStream("gzip") 对这种尾部
# 垃圾字节零容忍，会抛 "Trailing bytes after end of compressed data"（Node 的
# zlib 和命令行 gzip 都会静默忽略，所以本地用 gzip -t / zlib 验证是发现不了这个
# 问题的）。改成 tar 只管打包、单独 pipe 给独立的 gzip 命令，产出干净的单一
# gzip 流，没有块对齐这回事。
TAR_NO_META=(--no-xattrs --no-mac-metadata --no-acls --no-fflags)
( cd "$TMP/flat" && COPYFILE_DISABLE=1 tar cf - "${TAR_NO_META[@]}" . | gzip -n ) > "$OUT/flat-dot.tar.gz"

# 外层包裹一层目录的 zip —— GitHub 下载的压缩包就是这个形状
mkdir -p "$TMP/wrap" && cp -R "$TMP/flat" "$TMP/wrap/demo-skill"
( cd "$TMP/wrap" && zip -q -r - demo-skill ) > "$OUT/wrapped.zip"

# 根目录直接是 SKILL.md 的 zip
( cd "$TMP/flat" && zip -q -r - . ) > "$OUT/flat.zip"

# 缺少 SKILL.md 的 zip
mkdir -p "$TMP/bad" && echo 'nope' > "$TMP/bad/README.md"
( cd "$TMP/bad" && zip -q -r - . ) > "$OUT/no-skill-md.zip"

# 含软链接的 tar.gz
mkdir -p "$TMP/link" && cp "$TMP/flat/SKILL.md" "$TMP/link/SKILL.md"
ln -s /etc/passwd "$TMP/link/evil"
( cd "$TMP/link" && COPYFILE_DISABLE=1 tar cf - "${TAR_NO_META[@]}" . | gzip -n ) > "$OUT/symlink.tar.gz"

ls -l "$OUT"
