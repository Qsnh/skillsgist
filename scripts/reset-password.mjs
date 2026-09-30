#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { hashPassword, MIN_PASSWORD_LENGTH, resetPasswordSql, USERNAME } from "./reset-password-lib.mjs";

const USAGE = "Usage: npm run reset-password -- [username] [--local]";
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let username;
  let local = false;
  for (const arg of argv) {
    if (arg === "--local") local = true;
    else if (arg.startsWith("-") || username !== undefined) fail(USAGE);
    else username = arg;
  }
  return { username, local };
}

const piped = process.stdin.isTTY ? null : createInterface({ input: process.stdin });
const pipedLines = piped?.[Symbol.asyncIterator]();

async function ask(query, { hidden = false } = {}) {
  if (pipedLines) {
    const { value, done } = await pipedLines.next();
    if (done) fail("Unexpected end of input.");
    return value;
  }
  if (hidden) return askHidden(query);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => fail("\nCancelled."));
  try {
    return await rl.question(query);
  } finally {
    rl.close();
  }
}

function askHidden(query) {
  const { stdin, stdout } = process;
  stdout.write(query);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          stdin.setRawMode(false);
          fail("\nCancelled.");
        }
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function wrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], { stdio: ["inherit", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function wranglerError(parsed, stdout) {
  const error = parsed?.error;
  if (!error) return stdout.trim();
  return [error.text, ...(error.notes ?? []).map((note) => note.text)].filter(Boolean).join("\n");
}

const { username: given, local } = parseArgs(process.argv.slice(2));
const target = local ? "local" : "remote";
const username = (given ?? (await ask("Username: "))).trim();
if (!USERNAME.test(username)) fail(`"${username}" is not a valid username.`);
const password = await ask("New password: ", { hidden: true });
if (password.length < MIN_PASSWORD_LENGTH) fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
if ((await ask("Repeat the new password: ", { hidden: true })) !== password) fail("The passwords do not match.");
piped?.close();

const sql = resetPasswordSql(username, await hashPassword(password));
const { code, stdout } = await wrangler(["d1", "execute", "DB", `--${target}`, "--json", "--command", sql]);
const parsed = parseJson(stdout);
if (code !== 0) fail(`Wrangler failed:\n${wranglerError(parsed, stdout)}`);
if (!parsed?.[0]?.results?.length) fail(`No user named "${username}" in the ${target} database.`);
process.stdout.write(`Reset the password of "${username}" in the ${target} database. Sign in at /login with the new password.\n`);
