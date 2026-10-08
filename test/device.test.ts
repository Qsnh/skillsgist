import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LOCALE_COOKIE } from "../src/i18n/locales";
import { zhCN } from "../src/i18n/zh-CN";
import { env, get, joinProject, ORIGIN, postFields, postForm, resetDb, seedAndLogin, seedProject } from "./helpers";

async function startDevice(fields: Record<string, string> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/api/oauth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "skillsgist-cli", device_name: "work-laptop", ...fields }),
  });
  return res.json<{ device_code: string; user_code: string }>();
}

const grants = async () =>
  (await env.DB.prepare("SELECT project FROM cli_login_projects ORDER BY project").all<{ project: string }>()).results.map((r) => r.project);

const status = async () => (await env.DB.prepare("SELECT status FROM cli_logins").first<{ status: string }>())?.status;

beforeEach(async () => {
  await resetDb();
  await seedProject("team-b", "Team B");
  await seedProject("team-c", "Team C");
});

describe("reaching the page", () => {
  it("sends a signed-out visitor to sign in and back to the code afterwards", async () => {
    const { user_code } = await startDevice();
    const res = await get(`/device?code=${user_code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(`/device?code=${user_code}`)}`);
    const form = await (await get(res.headers.get("Location")!)).text();
    expect(form).toContain(`name="next" value="/device?code=${user_code}"`);
  });

  it("returns to next after signing in, and ignores a next that leaves the site", async () => {
    const { user, password } = await seedAndLogin({ username: "alice" });
    const signIn = (next: string) =>
      SELF.fetch(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: new URLSearchParams({ username: user.username, password, next }),
        redirect: "manual",
      });
    expect((await signIn("/device?code=BCDF-GHJK")).headers.get("Location")).toBe("/device?code=BCDF-GHJK");
    expect((await signIn("//evil.example/")).headers.get("Location")).toBe("/");
  });

  it("only prefills the code from the address", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const html = await (await get(`/device?code=${user_code.toLowerCase()}`, cookie)).text();
    expect(html).toContain(`value="${user_code}"`);
    expect(html).not.toContain('value="approve"');
    expect(await status()).toBe("pending");
  });
});

describe("approving", () => {
  it("shows the request, escapes the device name, and preselects the requested projects the user is in", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await joinProject(user.id, "team-b");
    const { user_code } = await startDevice({ device_name: "<b>laptop</b>", scope: "project:team-b project:team-c" });
    const res = await postForm("/device", cookie, { code: user_code });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;laptop&lt;/b&gt;");
    expect(html).toContain("Approve only if you ran skillsgist login yourself just now.");
    expect(html).toMatch(/<input type="checkbox" name="project" value="team-b"[^>]*checked/);
    expect(html).toMatch(/<input type="checkbox" name="project" value="default"(?![^>]*checked)[^>]*>/);
    expect(html).not.toContain('value="team-c"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
  });

  it("grants only the ticked projects the user is in, then says to return to the terminal", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await joinProject(user.id, "team-b");
    const { user_code } = await startDevice();
    const res = await postFields("/device", cookie, [
      ["code", user_code], ["decision", "approve"], ["project", "team-b"], ["project", "team-c"], ["project", "default"],
    ]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Return to your terminal");
    expect(await grants()).toEqual(["default", "team-b"]);
    expect(await status()).toBe("approved");
  });

  it("asks again when no project is ticked, or only projects the user is not in", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    for (const fields of [[["code", user_code], ["decision", "approve"]], [["code", user_code], ["decision", "approve"], ["project", "team-c"]]] as Array<Array<[string, string]>>) {
      const res = await postFields("/device", cookie, fields);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Choose at least one project");
    }
    expect(await status()).toBe("pending");
  });

  it("offers only Deny to a user in no project", async () => {
    const { cookie } = await seedAndLogin({ username: "loner", project: null });
    const { user_code } = await startDevice();
    const html = await (await postForm("/device", cookie, { code: user_code })).text();
    expect(html).toContain("You are not in any project");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });

  it("denies a request", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const res = await postFields("/device", cookie, [["code", user_code], ["decision", "deny"]]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Request denied");
    expect(await status()).toBe("denied");
  });

  it("refuses a used code", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
    const again = await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("That code is wrong or has expired");
  });
});

describe("wrong codes", () => {
  it("locks code entry after five wrong codes, even for a right one", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    for (let i = 0; i < 5; i++) expect((await postForm("/device", cookie, { code: "BBBB-BBBB" })).status).toBe(400);
    const locked = await postForm("/device", cookie, { code: user_code });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many wrong codes");
  });
});

describe("languages", () => {
  it("renders the confirmation in Chinese", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const res = await postForm("/device", `${cookie}; ${LOCALE_COOKIE}=zh-CN`, { code: user_code });
    expect(await res.text()).toContain(zhCN.device.confirmTitle);
  });
});
