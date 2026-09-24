import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { RENDER_REVISION } from "../src/render/markdown";
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

  it("renders a hidden copy button instead of the select hint", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(html).toContain(`<div class="cf-command" data-copy="true">`);
    expect(html).toContain(`<button type="button" class="cf-command-copy" hidden="">`);
    expect(html).toContain(`<span class="cf-command-copy-label">Copy</span>`);
    expect(html).toContain(`<span class="cf-command-status sr-only" role="status"></span>`);
    expect(html).not.toContain("Click to select");
  });

  it("shows only the author in a cell's meta row", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const meta = /<p class="cf-cell-meta">([\s\S]*?)<\/p>/.exec(html)?.[1];
    expect(meta).toContain("alice");
    expect(meta).not.toContain("v1");
    expect(meta).not.toContain("<time");
  });
});

describe("GET /s/:slug", () => {
  beforeEach(resetDb);

  it("shows the author and visibility but no version or date in the panel meta", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`)).text();
    const meta = /<p class="cf-hero-meta">([\s\S]*?)<\/p>/.exec(html)?.[1];
    expect(meta).toContain("alice");
    expect(meta).toContain("Public");
    expect(meta).not.toContain("v1");
    expect(meta).not.toContain("<time");
  });

  it("re-renders html stored by an older renderer and saves it", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await env.DB.prepare("UPDATE versions SET html = ?, html_rev = 0 WHERE slug = ?")
      .bind("<hr>\n<h2>name: demo-skill</h2>", "demo-skill")
      .run();

    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`)).text();
    expect(html).not.toContain("name: demo-skill</h2>");
    expect(html).toContain("Demo Heading");

    const row = await env.DB.prepare("SELECT html, html_rev FROM versions WHERE slug = ? AND version = 1")
      .bind("demo-skill")
      .first<{ html: string; html_rev: number }>();
    expect(row?.html_rev).toBe(RENDER_REVISION);
    expect(row?.html).toContain("Demo Heading");
  });

  it("heals an older version viewed with ?v=", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, GOOD_MD.replace("Demo Heading", "Second Heading"), "public");
    await env.DB.prepare("UPDATE versions SET html = ?, html_rev = 0 WHERE slug = ? AND version = 1")
      .bind("<h2>stale</h2>", "demo-skill")
      .run();

    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill?v=1`)).text();
    expect(html).not.toContain("stale");
    expect(html).toContain("Demo Heading");
  });

  it("still serves a healed page when saving the re-rendered html fails", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await env.DB.prepare("UPDATE versions SET html = ?, html_rev = 0 WHERE slug = ?")
      .bind("<h2>stale</h2>", "demo-skill")
      .run();
    await env.DB.prepare(
      "CREATE TRIGGER reject_html_write BEFORE UPDATE OF html ON versions BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    ).run();

    try {
      const res = await SELF.fetch(`${ORIGIN}/s/demo-skill`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("stale");
      expect(html).toContain("Demo Heading");
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_html_write").run();
    }
  });

  it("serves current html from storage without re-rendering", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await env.DB.prepare("UPDATE versions SET html = ? WHERE slug = ?")
      .bind("<p>stored-sentinel</p>", "demo-skill")
      .run();

    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`)).text();
    expect(html).toContain("stored-sentinel");
  });

  it("renders SKILL.md with a fold hook and a hidden Show more toggle", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`)).text();
    expect(html).toContain(`<div id="skill-doc" class="skill-doc" data-fold="true">`);
    expect(html).toContain(
      `<footer class="cf-fold-foot" hidden=""><button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls="skill-doc" aria-expanded="false">Show more</button></footer>`,
    );
  });

  it("renders the Files and Versions lists with fold hooks and hidden Show more toggles", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`)).text();
    for (const id of ["skill-files", "skill-versions"]) {
      expect(html).toContain(`<ul id="${id}" class="cf-rows" data-fold="true">`);
      expect(html).toContain(
        `</div><footer class="cf-fold-foot" hidden=""><button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls="${id}" aria-expanded="false">Show more</button></footer></section>`,
      );
    }
  });

  it("renders the stored html and the install command", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Demo Heading");
    expect(html).toContain("SKILL.md");
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${user.install_key}`);
  });

  // Pull the URL out of the rendered output rather than rebuilding it here —
  // what these two cases verify is precisely that *the one shown on the page*
  // works, and rebuilding it would reimplement the thing under test, so a
  // change to the view would not turn them red.
  // The whole html comes back alongside it, so "an anonymous page must not
  // contain /i/" can keep asserting against the full page.
  const installCommandOn = async (path: string, cookie?: string) => {
    const res = await SELF.fetch(`${ORIGIN}${path}`, cookie ? { headers: { Cookie: cookie } } : {});
    const html = await res.text();
    const url = /npx skills add ([^<\s]+)/.exec(html)?.[1];
    if (!url) throw new Error(`${path} rendered no install command (status ${res.status})`);
    return { url, html };
  };

  // Walk the displayed address the way the CLI actually does: append a
  // .well-known layer, fetch the index, then fetch entry.url. The index must
  // hold *only* this skill — `skills add` installs every entry it finds, so one
  // extra entry is one extra skill installed.
  //
  // Both cases publish two skills: with only one, an un-narrowed index would
  // also hold exactly one entry and the assertion would pass anyway.
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

  it("puts skill deletion behind a confirm step that names the skill", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    const html = await (await SELF.fetch(`${ORIGIN}/s/demo-skill`, { headers: { Cookie: cookie } })).text();

    const blocks = html.match(/<div class="cf-toolbar-group cf-toolbar-end"><details class="cf-confirm">[\s\S]*?<\/details>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/<summary class="cf-btn cf-btn-ghost cf-btn-ghost-danger"><svg [^>]*>[\s\S]*?<\/svg>Delete<\/summary>/);
    expect(blocks[0]).toContain(`<p class="cf-hint">Deleting removes demo-skill and all of its versions.`);
    expect(blocks[0]).toContain(`action="/s/demo-skill/delete"`);
    expect(blocks[0]).toContain(`<button type="submit" class="cf-btn cf-btn-danger">Delete demo-skill</button>`);
    expect(html.split("/s/demo-skill/delete")).toHaveLength(2);
  });

  it("stops a member touching another user's skill", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    await publish(alice.cookie, GOOD_MD, "private");
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    expect((await postForm("/s/demo-skill/visibility", cookie)).status).toBe(403);
    expect((await postForm("/s/demo-skill/delete", cookie)).status).toBe(403);
  });
});
