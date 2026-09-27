#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const page = `${pathToFileURL(join(here, "logo.html")).href}#export`;

const dom = execFileSync(chrome, ["--headless=new", "--disable-gpu", "--dump-dom", page], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "ignore"],
});

const files = new Map();
for (const [, file, data] of dom.matchAll(/<pre data-file="([^"]+)">data:image\/png;base64,([^<]+)<\/pre>/g)) {
  files.set(file, [...(files.get(file) ?? []), Buffer.from(data, "base64")]);
}
if (files.size === 0) throw new Error("scripts/logo.html rendered no icons");

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const size = png.readUInt32BE(16);
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

for (const [file, pngs] of files) {
  writeFileSync(join(here, "..", file), file.endsWith(".ico") ? ico(pngs) : pngs[0]);
  process.stdout.write(`${file}\n`);
}
