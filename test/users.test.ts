import { env as rawEnv, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/auth";
import { countUsers, getUserByUsername } from "../src/db/queries";
import { login, resetDb, seedUser } from "./helpers";

// See test/db.test.ts for why `env` needs a local cast here.
const env = rawEnv as unknown as { DB: D1Database };

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
  redirect: "manual" as const,
});

describe("/setup", () => {
  beforeEach(resetDb);

  it("is reachable while no user exists", async () => {
    const res = await SELF.fetch("http://localhost/setup");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("创建管理员");
  });

  it("creates the first admin and signs them in", async () => {
    const res = await SELF.fetch(
      "http://localhost/setup",
      form({ username: "root", password: "a-very-long-password" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
    const user = await getUserByUsername(env.DB, "root");
    expect(user?.role).toBe("admin");
    expect(user?.install_key).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const res = await SELF.fetch("http://localhost/setup", form({ username: "root", password: "short" }));
    expect(res.status).toBe(400);
    expect(await countUsers(env.DB)).toBe(0);
  });

  it("returns 404 once a user exists", async () => {
    await seedUser();
    expect((await SELF.fetch("http://localhost/setup")).status).toBe(404);
  });

  it("cannot bootstrap a second admin after the first succeeds", async () => {
    const first = await SELF.fetch(
      "http://localhost/setup",
      form({ username: "root", password: "a-very-long-password" }),
    );
    expect(first.status).toBe(302);

    const second = await SELF.fetch(
      "http://localhost/setup",
      form({ username: "intruder", password: "another-long-password" }),
    );
    expect(second.status).toBe(404);
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(await countUsers(env.DB)).toBe(1);
  });
});

describe("/login", () => {
  beforeEach(resetDb);

  it("sets a session cookie on success", async () => {
    const { password } = await seedUser({ username: "alice" });
    const res = await SELF.fetch("http://localhost/login", form({ username: "alice", password }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("sg_session=");
  });

  it("gives the same generic error for a bad password and a missing user", async () => {
    await seedUser({ username: "alice" });
    const bad = await SELF.fetch("http://localhost/login", form({ username: "alice", password: "wrong-password-x" }));
    const missing = await SELF.fetch("http://localhost/login", form({ username: "nobody", password: "wrong-password-x" }));
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await bad.text()).toContain("用户名或密码不正确");
    expect(await missing.text()).toContain("用户名或密码不正确");
  });

  it("still runs the password derivation when the username doesn't exist", async () => {
    // Structural proxy for the timing-safety property: a missing user must
    // not skip `verifyPassword`, or the two failure paths take measurably
    // different CPU time and a username can be enumerated by timing. We
    // don't assert on wall-clock timing (flaky); we assert the call happens.
    const spy = vi.spyOn(auth, "verifyPassword");
    try {
      const res = await SELF.fetch(
        "http://localhost/login",
        form({ username: "nobody", password: "wrong-password-x" }),
      );
      expect(res.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("/me", () => {
  beforeEach(resetDb);

  it("redirects anonymous visitors to /login", async () => {
    const res = await SELF.fetch("http://localhost/me", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("shows a ready-to-copy install command", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me", { headers: { Cookie: cookie } });
    const html = await res.text();
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  it("rotates the install key", async () => {
    const { user, password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me/install-key", {
      ...form({}), headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(res.status).toBe(302);
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.install_key).not.toBe(user.install_key);
  });

  it("issues an api token once and stores only its hash", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me/api-token", {
      ...form({}), headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    const html = await res.text();
    const match = /sgt_[a-f0-9]{32}/.exec(html);
    expect(match).not.toBeNull();
    const after = await getUserByUsername(env.DB, "alice");
    expect(after?.api_token_hash).not.toBeNull();
    expect(after?.api_token_hash).not.toContain(match![0]);
  });

  it("changes the password when the current one is supplied", async () => {
    const { password } = await seedUser({ username: "alice" });
    const cookie = await login("alice", password);
    const res = await SELF.fetch("http://localhost/me/password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ current: password, next: "another-long-password" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    await login("alice", "another-long-password");
  });
});

describe("/admin/users", () => {
  beforeEach(resetDb);

  it("is forbidden for members", async () => {
    const { password } = await seedUser({ username: "bob", role: "member" });
    const cookie = await login("bob", password);
    const res = await SELF.fetch("http://localhost/admin/users", { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it("lets an admin create a member", async () => {
    const { password } = await seedUser({ username: "root", role: "admin" });
    const cookie = await login("root", password);
    const res = await SELF.fetch("http://localhost/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ username: "carol", password: "carols-long-password", role: "member" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const carol = await getUserByUsername(env.DB, "carol");
    expect(carol?.role).toBe("member");
  });
});
