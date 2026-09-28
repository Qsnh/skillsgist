import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { returnPath, safeNext } from "../src/paths";
import { csrfFor, get, ORIGIN, postForm, resetDb, seedAndLogin, seedUser } from "./helpers";

const switchAnonymously = (fields: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}/lang`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

const langCookie = (res: Response) => res.headers.getSetCookie().find((line) => line.startsWith("sg_lang="));

const switcher = (html: string) => /<form method="post" action="\/lang"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";

describe("safeNext", () => {
  it.each(["/", "/p/default?q=a", "/p/default/s/demo-skill?v=2"])("keeps %s", (path) => {
    expect(safeNext(path)).toBe(path);
  });

  it.each([
    undefined,
    "",
    "p/default",
    "//evil.example.com",
    "/\\evil.example.com",
    "/\t/evil.example.com",
    "/\n/evil.example.com",
    "https://evil.example.com",
    "javascript:alert(1)",
  ])("replaces %o with /", (value) => {
    expect(safeNext(value)).toBe("/");
  });
});

describe("returnPath", () => {
  it("is the current path and query on a GET", () => {
    expect(returnPath("GET", `${ORIGIN}/p/default?q=%E6%97%A5`, undefined)).toBe("/p/default?q=%E6%97%A5");
  });

  it("is the same-origin Referer's path on a POST", () => {
    expect(returnPath("POST", `${ORIGIN}/me/api-token`, `${ORIGIN}/me`)).toBe("/me");
  });

  it.each([undefined, "https://evil.example.com/me", "not a url"])("is / on a POST with Referer %o", (referer) => {
    expect(returnPath("POST", `${ORIGIN}/me/api-token`, referer)).toBe("/");
  });
});

describe("POST /lang", () => {
  beforeEach(resetDb);

  it("remembers the language for a year and returns to the page", async () => {
    const res = await switchAnonymously({ lang: "ja", next: "/login" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    const cookie = langCookie(res);
    for (const part of ["sg_lang=ja", "Max-Age=31536000", "Path=/", "HttpOnly", "SameSite=Lax"]) {
      expect(cookie).toContain(part);
    }
    const html = await (
      await SELF.fetch(`${ORIGIN}/login`, { headers: { Cookie: "sg_lang=ja", "Accept-Language": "zh-CN" } })
    ).text();
    expect(html).toContain('<html lang="ja">');
  });

  it("ignores an unsupported language but still returns to the page", async () => {
    const res = await switchAnonymously({ lang: "klingon", next: "/login" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(langCookie(res)).toBeUndefined();
  });

  it("never redirects off the site", async () => {
    const res = await switchAnonymously({ lang: "ja", next: "//evil.example.com" });
    expect(res.headers.get("Location")).toBe("/");
  });

  it("takes a signed-in user's CSRF token", async () => {
    const { cookie } = await seedAndLogin();
    const res = await postForm("/lang", cookie, { lang: "zh-CN", next: "/me" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/me");
    expect(langCookie(res)).toContain("sg_lang=zh-CN");
  });
});

describe("footer language switcher", () => {
  beforeEach(resetDb);

  it("offers the other three languages and marks the current one", async () => {
    const form = switcher(
      await (await SELF.fetch(`${ORIGIN}/?q=x`, { headers: { "Accept-Language": "ja" } })).text(),
    );
    expect(form).toContain('<input type="hidden" name="next" value="/?q=x"/>');
    expect(form).toContain('<span lang="ja">日本語</span>');
    expect(form).toContain('<span class="cf-menu-item cf-lang-option" aria-current="true" lang="ja">日本語');
    expect(form).toContain('name="lang" value="en"');
    expect(form).toContain('name="lang" value="zh-CN"');
    expect(form).toContain('name="lang" value="zh-TW"');
    expect(form).not.toContain('value="ja"');
  });

  it("carries the session's token for a signed-in user and none for a visitor", async () => {
    const { cookie } = await seedAndLogin();
    expect(switcher(await (await get("/", cookie)).text())).toContain('name="_csrf"');
    expect(switcher(await (await get("/")).text())).not.toContain('name="_csrf"');
  });

  it("returns to the form's page after a POST re-renders it", async () => {
    const { cookie } = await seedAndLogin();
    const res = await SELF.fetch(`${ORIGIN}/me/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        Referer: `${ORIGIN}/me`,
        Cookie: cookie,
      },
      body: new URLSearchParams({ _csrf: await csrfFor(cookie), current: "wrong-password", next: "another-long-password" }),
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(switcher(await res.text())).toContain('name="next" value="/me"');
  });
});

describe("footer language switcher after chained POSTs", () => {
  beforeEach(resetDb);

  const postFrom = async (cookie: string, path: string, referer: string, fields: Record<string, string>) =>
    SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        Referer: `${ORIGIN}${referer}`,
        Cookie: cookie,
      },
      body: new URLSearchParams({ _csrf: await csrfFor(cookie), ...fields }),
      redirect: "manual",
    });

  it.each<[string, (bob: string) => [path: string, referer: string, fields: Record<string, string>, back: string]]>([
    ["a second failed password change", () => ["/me/password", "/me/password", { current: "wrong-password", next: "another-long-password" }, "/me"]],
    ["a new token after a failed password change", () => ["/me/api-token", "/me/password", {}, "/me"]],
    ["a second failed project rename", () => ["/p/default/rename", "/p/default/rename", { name: "" }, "/p/default/settings"]],
    ["a second failed admin password reset", (bob) => [`/admin/users/${bob}/password`, `/admin/users/${bob}/password`, { password: "short" }, `/admin/users/${bob}`]],
  ])("returns to the page's own address after %s", async (_label, request) => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: bob } = await seedUser({ username: "bob", role: "member" });
    const [path, referer, fields, back] = request(bob.id);
    const res = await postFrom(cookie, path, referer, fields);
    expect(res.status).toBeLessThan(500);
    expect(switcher(await res.text())).toContain(`name="next" value="${back}"`);
  });
});
