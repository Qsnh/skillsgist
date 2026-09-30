import { beforeEach, describe, expect, it } from "vitest";
import * as auth from "../src/auth";
import * as users from "../src/routes/users";
import { hashPassword, MIN_PASSWORD_LENGTH, resetPasswordSql, USERNAME } from "../scripts/reset-password-lib.mjs";
import { env, login, postForm, resetDb, seedUser } from "./helpers";

const NEW_PASSWORD = "a-brand-new-password";

const reset = async (username: string, password: string) =>
  (await env.DB.prepare(resetPasswordSql(username, await hashPassword(password))).all()).results;

describe("reset-password script", () => {
  beforeEach(resetDb);

  it("uses the app's username and password rules", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(auth.MIN_PASSWORD_LENGTH);
    expect(USERNAME.source).toBe(users.USERNAME.source);
  });

  it("writes a hash the app accepts", async () => {
    const hash = await hashPassword(NEW_PASSWORD);
    expect(await auth.verifyPassword(NEW_PASSWORD, hash)).toBe(true);
    expect(await auth.verifyPassword("not-the-new-password", hash)).toBe(false);
  });

  it("replaces the password so only the new one signs in", async () => {
    const { user, password } = await seedUser();
    expect(await reset(user.username, NEW_PASSWORD)).toEqual([{ username: user.username }]);
    expect(await login(user.username, NEW_PASSWORD)).toMatch(/^sg_session=/);
    const old = await postForm("/login", null, { username: user.username, password });
    expect(old.status).toBe(401);
  });

  it("returns no rows for an unknown user", async () => {
    await seedUser();
    expect(await reset("nobody", NEW_PASSWORD)).toEqual([]);
  });

  it("rejects usernames that could break out of the SQL string", () => {
    expect(() => resetPasswordSql("alice' OR '1'='1", "pbkdf2$10000$c2FsdA==$aGFzaA==")).toThrow();
    expect(() => resetPasswordSql("alice", "pbkdf2$10000$x'$y")).toThrow();
  });
});
