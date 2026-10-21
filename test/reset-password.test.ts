import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth";
import { openDatabase } from "../src/db/database";
import { createUser, getUserByUsername } from "../src/db/queries";
import { resetPassword, ResetError } from "../src/password-reset";
import { bearer, env, fetchWith, login, postForm, resetDb, seedUser, signInDevice } from "./helpers";

const NEW_PASSWORD = "a-brand-new-password";

describe("resetPassword", () => {
  beforeEach(resetDb);

  it("replaces the password so only the new one signs in", async () => {
    const { user, password } = await seedUser();
    await resetPassword(env.db, user.username, NEW_PASSWORD);
    expect(await login(user.username, NEW_PASSWORD)).toMatch(/^sg_session=/);
    expect((await postForm("/login", null, { username: user.username, password })).status).toBe(401);
  });

  it("signs out every computer signed in to the account with the CLI", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { token } = await signInDevice(user.id, ["default"]);
    await resetPassword(env.db, "alice", NEW_PASSWORD);
    expect((await fetchWith("/api/whoami", bearer(token))).status).toBe(401);
  });

  it.each([
    ["an unknown account", "nobody", NEW_PASSWORD, /No user named "nobody"/],
    ["an invalid username", "Alice'; --", NEW_PASSWORD, /not a valid username/],
    ["a short password", "alice", "short", /at least 12 characters/],
  ])("refuses %s and changes nothing", async (_label, username, password, message) => {
    const { user } = await seedUser({ username: "alice" });
    await expect(resetPassword(env.db, username, password)).rejects.toThrow(ResetError);
    await expect(resetPassword(env.db, username, password)).rejects.toThrow(message);
    expect(getUserByUsername(env.db, "alice")?.password_hash).toBe(user.password_hash);
  });
});

describe("npm run reset-password", () => {
  it("reads the username and the new password twice from piped input and writes a hash the app accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skillsgist-reset-"));
    const db = openDatabase(join(dir, "skillsgist.db"));
    createUser(db, { id: "u1", username: "alice", passwordHash: await hashPassword("the-old-password"), role: "admin" });
    db.close();

    const run = spawnSync("npx", ["tsx", "src/reset-password.ts"], {
      input: `alice\n${NEW_PASSWORD}\n${NEW_PASSWORD}\n`,
      env: { ...process.env, DATA_DIR: dir, DATABASE_PATH: "" },
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Reset the password of "alice"');

    const after = openDatabase(join(dir, "skillsgist.db"));
    expect(await verifyPassword(NEW_PASSWORD, getUserByUsername(after, "alice")!.password_hash)).toBe(true);
    after.close();
  });

  it("refuses passwords that do not match", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillsgist-reset-"));
    openDatabase(join(dir, "skillsgist.db")).close();
    const run = spawnSync("npx", ["tsx", "src/reset-password.ts", "alice"], {
      input: `${NEW_PASSWORD}\nsomething-else-entirely\n`,
      env: { ...process.env, DATA_DIR: dir, DATABASE_PATH: "" },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("The passwords do not match.");
  });

  it("refuses to create a database that is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillsgist-reset-"));
    const run = spawnSync("npx", ["tsx", "src/reset-password.ts", "alice"], {
      input: "",
      env: { ...process.env, DATA_DIR: dir, DATABASE_PATH: "" },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`No database at ${join(dir, "skillsgist.db")}`);
  });
});
