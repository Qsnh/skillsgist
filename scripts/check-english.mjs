#!/usr/bin/env node
// Fails the build if any tracked file carries CJK characters.
//
// skillsgist ships to an English-speaking audience. Without a check the
// boundary erodes one comment at a time, and a reviewer reading a diff in a
// language they don't share cannot tell a translation from a behaviour
// change. Scanning tracked files (not the working tree) keeps .dev.vars,
// node_modules and local scratch files out of it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// U+3000-303F is CJK punctuation, U+4E00-9FFF ideographs, U+FF00-FFEF
// fullwidth forms. Described rather than exemplified on purpose: one literal
// sample character here would make this file its own first offender. Em dash
// and curly quotes sit outside these ranges — ordinary English typography.
const CJK = /[　-〿一-鿿＀-￯]/;

// Archives and images decode into byte soup that can trip the range check.
const BINARY = /\.(zip|gz|tgz|png|jpe?g|gif|ico|woff2?)$/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !BINARY.test(f));

const offenders = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (CJK.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
}

if (offenders.length > 0) {
  process.stderr.write(`check:english: ${offenders.length} line(s) contain CJK characters\n`);
  for (const o of offenders) process.stderr.write(`  ${o}\n`);
  process.exit(1);
}

process.stdout.write(`check:english: ${files.length} tracked files clean\n`);
