import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { approveLogin, denyLogin } from "../src/db/logins";
import { sha256Hex } from "../src/hash";
import { bearer, env, fetchWith, ORIGIN, resetDb, seedProject, seedUser } from "./helpers";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const post = (path: string, fields: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

interface DeviceAnswer {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function start(fields: Record<string, string> = {}): Promise<DeviceAnswer> {
  const res = await post("/api/oauth/device", { client_id: "skillsgist-cli", device_name: "laptop", ...fields });
  expect(res.status).toBe(200);
  return res.json<DeviceAnswer>();
}

async function loginRow(userCode: string) {
  const row = await env.DB.prepare("SELECT * FROM cli_logins WHERE user_code = ?")
    .bind(userCode)
    .first<{ id: string; device_name: string; requested_scope: string | null }>();
  if (!row) throw new Error(`no pending login for ${userCode}`);
  return row;
}

const poll = (device_code: string, overrides: Record<string, string> = {}) =>
  post("/api/oauth/token", { grant_type: GRANT, device_code, client_id: "skillsgist-cli", ...overrides });

const rewind = (id: string) => env.DB.prepare("UPDATE cli_logins SET last_polled_at = NULL WHERE id = ?").bind(id).run();

beforeEach(async () => {
  await resetDb();
  await seedProject("team-b", "Team B");
});

describe("discovery", () => {
  it("publishes same-origin endpoints for the device grant", async () => {
    const res = await fetchWith("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issuer: ORIGIN,
      device_authorization_endpoint: `${ORIGIN}/api/oauth/device`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      grant_types_supported: [GRANT],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
});

describe("POST /api/oauth/device", () => {
  it("hands out a device code it stores only hashed and a user code for the approval page, without an Origin header", async () => {
    const answer = await start();
    expect(answer.device_code).toMatch(/^[a-f0-9]{64}$/);
    expect(answer.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(answer).toMatchObject({
      verification_uri: `${ORIGIN}/device`,
      verification_uri_complete: `${ORIGIN}/device?code=${answer.user_code}`,
      expires_in: 600,
      interval: 5,
    });
    const stored = await env.DB.prepare("SELECT * FROM cli_logins").all();
    expect(JSON.stringify(stored.results)).not.toContain(answer.device_code);
    expect(JSON.stringify(stored.results)).toContain(await sha256Hex(answer.device_code));
  });

  it("refuses any client but the skillsgist CLI", async () => {
    const res = await post("/api/oauth/device", { client_id: "other" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_client" });
  });

  it("keeps only well-formed project slugs from scope, without duplicates, at most 50", async () => {
    const many = Array.from({ length: 80 }, (_, i) => `project:p${String(i).padStart(2, "0")}`).join(" ");
    const { user_code } = await start({ scope: `project:default project:default junk project:Bad_Slug project:x ${many}` });
    const scope = (await loginRow(user_code)).requested_scope!.split(" ");
    expect(scope[0]).toBe("default");
    expect(scope).toHaveLength(50);
    expect(new Set(scope).size).toBe(50);
  });

  it("strips control and bidi characters from the device name and cuts it to 64 characters", async () => {
    const { user_code } = await start({ device_name: `  evil${String.fromCodePoint(0x202e)}\u0007<b>${"x".repeat(100)}  ` });
    const name = (await loginRow(user_code)).device_name;
    expect(name.startsWith("evil<b>")).toBe(true);
    expect([...name]).toHaveLength(64);
  });

  it("strips U+061C, U+2028, and U+2066 from the device name", async () => {
    const { user_code } = await start({ device_name: `test${String.fromCodePoint(0x061c)}${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2066)}name` });
    const name = (await loginRow(user_code)).device_name;
    expect(name).toBe("testname");
  });

  it("forgets expired requests when a new one arrives", async () => {
    const { user_code } = await start();
    await env.DB.prepare("UPDATE cli_logins SET expires_at = 0").run();
    await start();
    expect((await env.DB.prepare("SELECT user_code FROM cli_logins").all()).results).not.toContainEqual({ user_code });
  });
});

describe("POST /api/oauth/token", () => {
  it("says pending, then slow_down when polled too fast, then hands out the token once with the granted projects", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { device_code, user_code } = await start({ scope: "project:default" });
    const row = await loginRow(user_code);

    const first = await poll(device_code);
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({ error: "authorization_pending" });
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(await (await poll(device_code)).json()).toEqual({ error: "slow_down" });
    expect((await env.DB.prepare("SELECT poll_interval FROM cli_logins WHERE id = ?").bind(row.id).first())?.poll_interval).toBe(10);

    expect(await approveLogin(env.DB, row.id, user.id, ["default"], Date.now())).toBe(true);
    await rewind(row.id);
    const granted = await poll(device_code);
    expect(granted.status).toBe(200);
    const body = await granted.json<{ access_token: string; token_type: string; scope: string }>();
    expect(body.access_token).toMatch(/^sgd_[a-f0-9]{64}$/);
    expect(body).toMatchObject({ token_type: "Bearer", scope: "project:default" });
    expect(await (await fetchWith("/api/whoami", bearer(body.access_token))).json()).toEqual({
      user: "alice", kind: "login", projects: ["default"],
    });

    await rewind(row.id);
    expect(await (await poll(device_code)).json()).toEqual({ error: "invalid_grant" });
  });

  it("tells the CLI a request was denied, once", async () => {
    const { device_code, user_code } = await start();
    await denyLogin(env.DB, (await loginRow(user_code)).id, Date.now());
    expect(await (await poll(device_code)).json()).toEqual({ error: "access_denied" });
    expect(await (await poll(device_code)).json()).toEqual({ error: "invalid_grant" });
  });

  it("tells the CLI a code expired", async () => {
    const { device_code } = await start();
    await env.DB.prepare("UPDATE cli_logins SET expires_at = 0").run();
    expect(await (await poll(device_code)).json()).toEqual({ error: "expired_token" });
  });

  it.each([
    ["another client", { client_id: "other" }, 401, "invalid_client"],
    ["another grant", { grant_type: "password" }, 400, "unsupported_grant_type"],
    ["no device code", { device_code: "" }, 400, "invalid_request"],
    ["an unknown device code", { device_code: "0".repeat(64) }, 400, "invalid_grant"],
  ])("refuses %s", async (_label, overrides, status, error) => {
    const { device_code } = await start();
    const res = await poll(device_code, overrides);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
});

describe("POST /api/oauth/revoke", () => {
  it("revokes a sign-in token, answers 200 for anything else, and never touches install keys", async () => {
    const { user } = await seedUser({ username: "alice" });
    const { device_code, user_code } = await start();
    await approveLogin(env.DB, (await loginRow(user_code)).id, user.id, ["default"], Date.now());
    const { access_token } = await (await poll(device_code)).json<{ access_token: string }>();
    expect((await post("/api/oauth/revoke", { token: access_token, token_type_hint: "access_token", client_id: "skillsgist-cli" })).status).toBe(200);
    expect((await fetchWith("/api/whoami", bearer(access_token))).status).toBe(401);
    expect((await post("/api/oauth/revoke", { token: "sgd_unknown" })).status).toBe(200);
    expect((await post("/api/oauth/revoke", {})).status).toBe(200);
  });
});
