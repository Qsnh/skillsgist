import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { databasePathFrom } from "./config";
import { openDatabase } from "./db/database";
import { resetPassword, ResetError } from "./password-reset";

const USAGE = "Usage: npm run reset-password -- [username]";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): string | undefined {
  let username: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("-") || username !== undefined) fail(USAGE);
    username = arg;
  }
  return username;
}

const piped = process.stdin.isTTY ? null : createInterface({ input: process.stdin });
const pipedLines = piped?.[Symbol.asyncIterator]();

async function ask(query: string, hidden = false): Promise<string> {
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

function askHidden(query: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(query);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
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

const file = databasePathFrom();
if (!existsSync(file)) fail(`No database at ${file}. Set DATA_DIR or DATABASE_PATH to the instance's data.`);

const username = (parseArgs(process.argv.slice(2)) ?? (await ask("Username: "))).trim();
const password = await ask("New password: ", true);
if ((await ask("Repeat the new password: ", true)) !== password) fail("The passwords do not match.");
piped?.close();

const db = openDatabase(file);
try {
  await resetPassword(db, username, password);
} catch (err) {
  if (err instanceof ResetError) fail(err.message);
  throw err;
} finally {
  db.close();
}
process.stdout.write(
  `Reset the password of "${username}". Computers signed in to it with the CLI were signed out. Sign in at /login with the new password.\n`,
);
