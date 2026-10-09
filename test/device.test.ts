import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { activateLogin, approveLogin } from "../src/db/logins";
import { LOCALE_COOKIE } from "../src/i18n/locales";
import { zhCN } from "../src/i18n/zh-CN";
import { en } from "../src/i18n/en";
import { env, follow, get, joinProject, ORIGIN, postFields, postForm, resetDb, seedAndLogin, seedProject } from "./helpers";

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

const loginId = async () => (await env.DB.prepare("SELECT id FROM cli_logins").first<{ id: string }>())!.id;

const failures = async () =>
  (await env.DB.prepare("SELECT COALESCE(SUM(failures), 0) AS n FROM device_code_attempts").first<{ n: number }>())?.n;

const switcher = (html: string) => /<form method="post" action="\/lang"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";

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

  it("sends a code typed after the session ended through sign-in and back to the code", async () => {
    const res = await postForm("/device", null, { code: "bcdf-ghjk", decision: "approve", project: "default" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/device?code=bcdf-ghjk")}`);
    expect((await postForm("/device", null, {})).headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/device")}`);
  });

  it("only prefills the code from the address", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const html = await (await get(`/device?code=${user_code.toLowerCase()}`, cookie)).text();
    expect(html).toContain(`value="${user_code}"`);
    expect(html).toMatch(/<input class="cf-input cf-input-code" name="code"[^>]*autocapitalize="characters" spellcheck="false"/);
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
    expect(html).toContain("Approve only if you ran <code>skillsgist login</code> yourself just now.");
    expect(html).toMatch(/<input type="checkbox" name="project" value="team-b"[^>]*checked/);
    expect(html).toMatch(/<input type="checkbox" name="project" value="default"(?![^>]*checked)[^>]*>/);
    expect(html).not.toContain('value="team-c"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
  });

  it("groups the project checkboxes under a legend", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const html = await (await postForm("/device", cookie, { code: user_code })).text();
    expect(html).toMatch(
      /<fieldset class="cf-form-section cf-fieldset"><legend class="cf-label">Projects it may install from<\/legend><div class="cf-choices">[\s\S]*?value="default"[\s\S]*?<\/fieldset>/,
    );
    expect(html).not.toContain("cf-choice-detail");
  });

  it("leads with the code to check against the terminal", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice({ device_name: "laptop" });
    const html = await (await postForm("/device", cookie, { code: user_code.toLowerCase() })).text();
    const code = html.indexOf(`<dd class="cf-device-code-value">${user_code}</dd>`);
    expect(code).toBeGreaterThan(-1);
    expect(html).toContain(en.device.codeCheck);
    expect(code).toBeLessThan(html.indexOf('<dd class="cf-row-value">laptop</dd>'));
  });

  it("labels the request time as UTC and names the country it came from", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const at = Date.UTC(2026, 8, 27, 14, 5);
    const show = async (country: string | null, extra = "") => {
      await env.DB.prepare("UPDATE cli_logins SET request_country = ?, created_at = ?").bind(country, at).run();
      return (await postForm("/device", `${cookie}${extra}`, { code: user_code })).text();
    };
    const html = await show("JP");
    expect(html).toContain(`<time datetime="${new Date(at).toISOString()}">Sep 27, 2026, 14:05 UTC</time>`);
    expect(html).toContain('<dd class="cf-row-value">Japan</dd>');
    expect(await show("JP", `; ${LOCALE_COOKIE}=ja`)).toContain('<dd class="cf-row-value">日本</dd>');
    expect(await show("T1")).toContain('<dd class="cf-row-value">Tor network</dd>');
    for (const unknown of ["XX", null]) expect(await show(unknown)).toContain('<dd class="cf-row-value">Unknown</dd>');
  });

  it("grants only the ticked projects the user is in, then says to return to the terminal", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await joinProject(user.id, "team-b");
    const { user_code } = await startDevice();
    const res = await postFields("/device", cookie, [
      ["code", user_code], ["decision", "approve"], ["project", "team-b"], ["project", "team-c"], ["project", "default"],
    ]);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/device/${await loginId()}`);
    const done = await (await follow(res, cookie)).text();
    expect(done).toContain("It can now install the private skills of Default and Team B.");
    expect(done).toContain("Return to your terminal");
    expect(done).toContain('You can sign it out on your <a href="/me" class="cf-link">account page</a> at any time.');
    expect(await grants()).toEqual(["default", "team-b"]);
    expect(await status()).toBe("approved");
  });

  it("asks again when no project is ticked, or only projects the user is not in", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    for (const fields of [[["code", user_code], ["decision", "approve"]], [["code", user_code], ["decision", "approve"], ["project", "team-c"]]] as Array<Array<[string, string]>>) {
      const res = await postFields("/device", cookie, fields);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Tick at least one project");
    }
    expect(await status()).toBe("pending");
  });

  it("offers only Deny to a user in no project", async () => {
    const { cookie } = await seedAndLogin({ username: "loner", project: null });
    const { user_code } = await startDevice();
    const html = await (await postForm("/device", cookie, { code: user_code })).text();
    expect(html).toContain("You are not in any project");
    expect(html).not.toContain("Approve only if");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });

  it("denies a request", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const res = await postFields("/device", cookie, [["code", user_code], ["decision", "deny"]]);
    expect(res.status).toBe(302);
    expect(await (await follow(res, cookie)).text()).toContain("Request denied");
    expect(await status()).toBe("denied");
  });

  it("shows the result again on reload without counting a wrong code, and only to the person who decided", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob" });
    const { user_code } = await startDevice();
    const res = await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
    const result = res.headers.get("Location")!;
    for (let i = 0; i < 6; i++) {
      const again = await get(result, cookie);
      expect(again.status).toBe(200);
      expect(await again.text()).toContain("Computer approved");
    }
    await env.DB.prepare("UPDATE cli_logins SET status = 'active'").run();
    expect(await (await get(result, cookie)).text()).toContain("Computer approved");
    expect(await failures()).toBe(0);
    expect((await postForm("/device", cookie, { code: "BBBB-BBBB" })).status).toBe(400);
    expect(await failures()).toBe(1);

    for (const [path, who] of [[result, bob.cookie], ["/device/nope", cookie]] as const) {
      const elsewhere = await get(path, who);
      expect(elsewhere.status).toBe(302);
      expect(elsewhere.headers.get("Location")).toBe("/device");
    }
    expect((await get(result)).headers.get("Location")).toBe(`/login?next=${encodeURIComponent(result)}`);
  });

  it("sends a reload back to code entry once a denied request is gone", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const res = await postFields("/device", cookie, [["code", user_code], ["decision", "deny"]]);
    const result = res.headers.get("Location")!;
    expect(await (await get(result, cookie)).text()).toContain("Request denied");
    await env.DB.prepare("DELETE FROM cli_logins").run();
    expect((await get(result, cookie)).headers.get("Location")).toBe("/device");
  });

  it("does not let an admin grant a project they are not a member of", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user_code } = await startDevice({ scope: "project:team-b" });
    const confirm = await (await postForm("/device", cookie, { code: user_code })).text();
    expect(confirm).not.toContain('value="team-b"');
    const res = await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "team-b"]]);
    expect(res.status).toBe(400);
    expect(await grants()).toEqual([]);
    expect(await status()).toBe("pending");
  });

  it("shows the result to the person who already decided, without counting a wrong code", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    expect((await postForm("/device", cookie, { code: user_code })).status).toBe(200);
    const id = await loginId();
    expect(await approveLogin(env.DB, id, user.id, ["default"], Date.now())).toBe(true);
    const approve: Array<[string, string]> = [["code", user_code], ["decision", "approve"], ["project", "default"]];
    for (const fields of [approve, [["code", user_code], ["decision", "deny"]], [["code", user_code]]] as Array<Array<[string, string]>>) {
      const res = await postFields("/device", cookie, fields);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/device/${id}`);
      const done = await (await follow(res, cookie)).text();
      expect(done).toContain("Computer approved");
      expect(done).not.toContain("Request denied");
    }
    expect(await status()).toBe("approved");
    expect(await failures()).toBe(0);
  });

  it("refuses a code someone else already used, and counts it as wrong", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob" });
    const { user_code } = await startDevice();
    await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
    const again = await postFields("/device", bob.cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("That code is wrong or has expired. Check the code in your terminal, or run <code>skillsgist login</code> again.");
    expect(await failures()).toBe(1);
  });

  it("asks again when the ticked projects are gone by the time the approval is written", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    await env.DB.prepare(
      `CREATE TRIGGER leave_mid_approval BEFORE INSERT ON cli_login_projects BEGIN
         DELETE FROM memberships WHERE project = NEW.project AND user_id = NEW.user_id;
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    try {
      const res = await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain(en.device.projectsGone);
      expect(html).toContain("You are not in any project");
      expect(html).not.toContain('value="approve"');
    } finally {
      await env.DB.prepare("DROP TRIGGER leave_mid_approval").run();
    }
    expect(await status()).toBe("pending");
    expect(await grants()).toEqual([]);
    expect((await env.DB.prepare("SELECT user_id FROM cli_logins").first<{ user_id: string | null }>())?.user_id).toBeNull();
  });

  it("treats the code of a finished sign-in as unknown", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const id = await loginId();
    expect(await approveLogin(env.DB, id, user.id, ["default"], Date.now())).toBe(true);
    expect(await activateLogin(env.DB, id, "token-hash", Date.now())).toBe(true);
    const res = await postForm("/device", cookie, { code: user_code });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That code is wrong or has expired");
    expect(await (await get(`/device/${id}`, cookie)).text()).toContain("Computer approved");
  });

  it("says a request expired when its confirmation page outlived it, without counting a wrong code", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    await env.DB.prepare("UPDATE cli_logins SET expires_at = ?").bind(Date.now() - 1).run();
    const res = await postFields("/device", cookie, [["code", user_code], ["decision", "approve"], ["project", "default"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This request expired before you answered it.");
    expect(await failures()).toBe(0);
    expect(await status()).toBe("pending");
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

  it("answers only five of many wrong codes sent at once", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const statuses = await Promise.all(Array.from({ length: 12 }, () => postForm("/device", cookie, { code: "BBBB-BBBB" }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 400)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it("still sends a locked-out user to the result of a request they already answered", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const id = await loginId();
    expect(await approveLogin(env.DB, id, user.id, ["default"], Date.now())).toBe(true);
    for (let i = 0; i < 5; i++) await postForm("/device", cookie, { code: "BBBB-BBBB" });
    expect((await postForm("/device", cookie, { code: "BBBB-BBBB" })).status).toBe(429);
    const res = await postForm("/device", cookie, { code: user_code });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/device/${id}`);
    expect(await (await follow(res, cookie)).text()).toContain("Computer approved");
  });
});

describe("languages", () => {
  it("renders the confirmation in Chinese", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const res = await postForm("/device", `${cookie}; ${LOCALE_COOKIE}=zh-CN`, { code: user_code });
    expect(await res.text()).toContain(zhCN.device.confirmTitle);
  });

  it("switches the language of the confirmation back to the code", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const { user_code } = await startDevice();
    const html = await (await postForm("/device", cookie, { code: user_code })).text();
    expect(switcher(html)).toContain(`name="next" value="/device?code=${user_code}"`);
  });
});
