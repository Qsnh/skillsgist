import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { env, ORIGIN, OTHER_MD, postForm, publishMarkdown as publish, resetDb, seedAndLogin } from "./helpers";

// This file asserts the rendered body reaches the page, so it wants a heading
// it can look for — the shared GOOD_MD's is just "# Demo".
const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo Heading\n";

describe("GET /", () => {
  beforeEach(resetDb);

  it("shows only public skills to anonymous visitors", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "private");

    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(html).toContain("demo-skill");
    expect(html).not.toContain("other-skill");
  });

  it("shows private skills to logged-in users", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    const html = await (await SELF.fetch(`${ORIGIN}/`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain("other-skill");
  });

  it("filters by query", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/?q=other`)).text();
    expect(html).toContain("other-skill");
    expect(html).not.toContain(">demo-skill<");
  });
});

describe("GET /s/:slug", () => {
  beforeEach(resetDb);

  it("renders the stored html and the install command", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Demo Heading");
    expect(html).toContain("SKILL.md");
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  // 从渲染结果里把 URL 抠出来，而不是自己拼一遍 —— 这两个用例要验证的恰恰是
  // 「页面展示的那一条」能用；自己拼就等于把被测对象重新实现一次，view 改了也不会红。
  // 整页 html 一并返回，好让「匿名页面不得出现 /i/」继续按整页断言。
  const installCommandOn = async (path: string, cookie?: string) => {
    const res = await SELF.fetch(`${ORIGIN}${path}`, cookie ? { headers: { Cookie: cookie } } : {});
    const html = await res.text();
    const url = /npx skills add ([^<\s]+)/.exec(html)?.[1];
    if (!url) throw new Error(`${path} 没有渲染出安装命令（status ${res.status}）`);
    return { url, html };
  };

  // 按 CLI 的真实动作走一遍展示出来的那条地址：往后拼一层 .well-known 取 index，
  // 再下 entry.url。index 必须**只**含这一个 skill —— `skills add` 会把 index 里
  // 的全部条目都装上，所以多一条就是多装一个 skill。
  //
  // 两个用例都发布两个 skill：只发一个的话，未收窄的 index 里也恰好只有一条，
  // 断言照样绿。
  it("shows an anonymous install command that resolves to just this skill", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, OTHER_MD, "public");

    const { url, html } = await installCommandOn("/s/demo-skill");
    expect(url).toBe(`${ORIGIN}/.well-known/agent-skills/demo-skill`);
    expect(html).not.toContain("/i/");

    const res = await SELF.fetch(`${url}/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Array<{ name: string; url: string }> }>();
    expect(body.skills.map((s) => s.name)).toEqual(["demo-skill"]);
    expect((await SELF.fetch(body.skills[0].url)).status).toBe(200);
  });

  it("shows a keyed install command that resolves to just this skill", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    await publish(cookie, OTHER_MD, "private");

    const { url } = await installCommandOn("/s/other-skill", cookie);
    expect(url).toBe(`${ORIGIN}/i/${user.install_key}/.well-known/agent-skills/other-skill`);

    const res = await SELF.fetch(`${url}/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Array<{ name: string; url: string }> }>();
    expect(body.skills.map((s) => s.name)).toEqual(["other-skill"]);
    expect((await SELF.fetch(body.skills[0].url)).status).toBe(200);
  });

  it("hides a private skill from anonymous visitors", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    expect((await SELF.fetch(`${ORIGIN}/s/other-skill`)).status).toBe(404);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await SELF.fetch(`${ORIGIN}/s/nope`)).status).toBe(404);
  });
});

describe("downloads", () => {
  beforeEach(resetDb);

  it("serves the latest version as an attachment", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch(`${ORIGIN}/s/demo-skill/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("demo-skill.zip");
  });

  it("serves a specific version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch(`${ORIGIN}/s/demo-skill/v/1/download`);
    expect(res.status).toBe(200);
  });

  it("refuses to serve a private skill to anonymous visitors", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    expect((await SELF.fetch(`${ORIGIN}/s/other-skill/download`)).status).toBe(404);
  });
});

describe("visibility and deletion", () => {
  beforeEach(resetDb);

  it("toggles visibility", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    await postForm("/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("public");
    await postForm("/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "demo-skill"))?.visibility).toBe("private");
  });

  it("deletes the skill and its r2 objects", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    expect(await env.BUCKET.get("skills/demo-skill/1.zip")).not.toBeNull();
    const res = await postForm("/s/demo-skill/delete", cookie);
    expect(res.status).toBe(302);
    expect(await getSkill(env.DB, "demo-skill")).toBeNull();
    expect(await env.BUCKET.get("skills/demo-skill/1.zip")).toBeNull();
  });

  it("stops a member touching another user's skill", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    await publish(alice.cookie, GOOD_MD, "private");
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    expect((await postForm("/s/demo-skill/visibility", cookie)).status).toBe(403);
    expect((await postForm("/s/demo-skill/delete", cookie)).status).toBe(403);
  });
});
