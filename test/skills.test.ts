import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill, getVersion, incrementDownloads, updateVersionHtml } from "../src/db/queries";
import { RENDER_REVISION } from "../src/render/markdown";
import {
  cellMeta, env, installKey, joinProject, ORIGIN, OTHER_MD, postForm, publishMarkdown as publish, resetDb, seedAndLogin,
  seedProject,
} from "./helpers";

// This file asserts the rendered body reaches the page, so it wants a heading
// it can look for — the shared GOOD_MD's is just "# Demo".
const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo Heading\n";

const COUNT_TEXT = /\d[\d,]* downloads?\b/;

const details = (html: string) => /<dl class="cf-rows">([\s\S]*?)<\/dl>/.exec(html)?.[1];

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
    expect(html).not.toContain(">Default/demo-skill<");
  });

  it("titles each cell with its project's name and its own", async () => {
    await seedProject("team-b", "Team B");
    const alice = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
    await publish(alice.cookie, GOOD_MD, "public");
    await publish(bob.cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(html).toContain('<a href="/p/default/s/demo-skill" class="cf-cell-link">Default/demo-skill</a>');
    expect(html).toContain('<a href="/p/team-b/s/demo-skill" class="cf-cell-link">Team B/demo-skill</a>');
  });

  it("shows only the author in a cell's meta row", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const meta = cellMeta(html);
    expect(meta).toContain("<span>alice</span>");
    expect(meta).not.toContain("Default");
    expect(meta).not.toContain("v1");
    expect(meta).not.toContain("<time");
  });

  it("shows a grouped download count in a cell's meta row to a signed-in user", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await env.DB.prepare("UPDATE skills SET download_count = 1234 WHERE slug = 'demo-skill'").run();

    const html = await (await SELF.fetch(`${ORIGIN}/`, { headers: { Cookie: cookie } })).text();
    const meta = cellMeta(html);
    expect(meta).toContain("alice");
    expect(meta).toContain("1,234 downloads");
  });

  it("shows zero downloads for a skill nobody has downloaded", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    const html = await (await SELF.fetch(`${ORIGIN}/`, { headers: { Cookie: cookie } })).text();
    expect(cellMeta(html)).toContain("0 downloads");
  });
});

describe("GET /p/:project/s/:slug", () => {
  beforeEach(resetDb);

  it("shows the author and visibility but no version or date in the Details panel, not on the orange panel", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    expect(html).toContain('<h2 class="cf-panel-title">Details</h2>');
    const meta = details(html);
    expect(meta).toContain('<dd class="cf-row-value">alice</dd>');
    expect(meta).toContain("Public");
    expect(meta).not.toContain("v1");
    expect(meta).not.toContain("<time");
    const hero = /<section class="cf-hero"[\s\S]*?<\/section>/.exec(html)?.[0];
    expect(hero).not.toContain("alice");
    expect(hero).not.toContain("cf-vis");
  });

  it("re-renders html stored by an older renderer and saves it", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<hr>\n<h2>name: demo-skill</h2>", 0);

    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    expect(html).not.toContain("name: demo-skill</h2>");
    expect(html).toContain("Demo Heading");

    const row = await getVersion(env.DB, "default", "demo-skill", 1);
    expect(row?.html_rev).toBe(RENDER_REVISION);
    expect(row?.html).toContain("Demo Heading");
  });

  it("heals an older version viewed with ?v=", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await publish(cookie, GOOD_MD.replace("Demo Heading", "Second Heading"), "public");
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<h2>stale</h2>", 0);

    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill?v=1`)).text();
    expect(html).not.toContain("stale");
    expect(html).toContain("Demo Heading");
  });

  it("still serves a healed page when saving the re-rendered html fails", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<h2>stale</h2>", 0);
    await env.DB.prepare(
      "CREATE TRIGGER reject_html_write BEFORE UPDATE OF html ON versions BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    ).run();

    try {
      const res = await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`);
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
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<p>stored-sentinel</p>", RENDER_REVISION);

    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    expect(html).toContain("stored-sentinel");
  });

  it("renders SKILL.md with a fold hook and a hidden Show more toggle", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    expect(html).toContain(`<div id="skill-doc" class="skill-doc" data-fold="true">`);
    expect(html).toContain(
      `<footer class="cf-fold-foot" hidden=""><button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls="skill-doc" aria-expanded="false">Show more</button></footer>`,
    );
  });

  it("renders the Files and Versions lists with fold hooks and hidden Show more toggles", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    for (const id of ["skill-files", "skill-versions"]) {
      expect(html).toContain(`<ul id="${id}" class="cf-rows" data-fold="true">`);
      expect(html).toContain(
        `</ul><footer class="cf-fold-foot" hidden=""><button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls="${id}" aria-expanded="false">Show more</button></footer></section>`,
      );
    }
  });

  it("renders a hidden copy button instead of the select hint", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    expect(html).toContain(`<div class="cf-command cf-command-raised" data-copy="true">`);
    expect(html).toContain(`<button type="button" class="cf-command-copy" hidden="">`);
    expect(html).toContain(`<span class="cf-command-copy-label">Copy</span>`);
    expect(html).toContain(`<span class="cf-command-status sr-only" role="status"></span>`);
    expect(html).not.toContain("Click to select");
  });

  it("renders the stored html and the install command", async () => {
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Demo Heading");
    expect(html).toContain("SKILL.md");
    expect(html).toContain(`npx skills add`);
    expect(html).toContain(`/i/${await installKey(user.id)}`);
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

    const { url, html } = await installCommandOn("/p/default/s/demo-skill");
    expect(url).toBe(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
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

    const { url, html } = await installCommandOn("/p/default/s/other-skill", cookie);
    expect(url).toBe(`${ORIGIN}/i/${await installKey(user.id)}/.well-known/agent-skills/other-skill`);
    expect(html).not.toContain("cf-hero-note");

    const res = await SELF.fetch(`${url}/.well-known/agent-skills/index.json`);
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: Array<{ name: string; url: string }> }>();
    expect(body.skills.map((s) => s.name)).toEqual(["other-skill"]);
    expect((await SELF.fetch(body.skills[0].url)).status).toBe(200);
  });

  it("shows the project's public address to a signed-in user outside a public skill's project", async () => {
    await seedProject("team-b", "Team B");
    const alice = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
    await publish(alice.cookie, GOOD_MD, "public");

    const { url, html } = await installCommandOn("/p/default/s/demo-skill", bob.cookie);
    expect(url).toBe(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
    expect(html).not.toContain("cf-hero-note");
  });

  it("shows no install command to an admin outside a private skill's project", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });
    await publish(alice.cookie, GOOD_MD, "private");

    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: root.cookie } })).text();
    expect(html).not.toContain("npx skills add");
    expect(html).not.toContain("cf-hero-note");
  });

  it("shows the project, linked, to everyone", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    for (const init of [{}, { headers: { Cookie: cookie } }]) {
      const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, init)).text();
      expect(details(html)).toContain('<a href="/p/default" class="cf-row-link">Default</a>');
    }
  });

  it("gives each project its own skill of the same name", async () => {
    await seedProject("team-b", "Team B");
    const alice = await seedAndLogin({ username: "alice" });
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
    await publish(alice.cookie, GOOD_MD, "public");
    await publish(bob.cookie, GOOD_MD.replace("Demo Heading", "Team B Heading"), "public");

    const ours = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    const theirs = await (await SELF.fetch(`${ORIGIN}/p/team-b/s/demo-skill`)).text();
    expect(ours).toContain("Demo Heading");
    expect(theirs).toContain("Team B Heading");
    expect(details(theirs)).toContain("bob");
    expect(ours).toContain('<h1 id="skill-title" class="cf-hero-title cf-skill-title">Default/demo-skill</h1>');
    expect(theirs).toContain('<h1 id="skill-title" class="cf-hero-title cf-skill-title">Team B/demo-skill</h1>');
    expect(theirs).toContain("<title>Team B/demo-skill · skillsgist</title>");
  });

  it("sends an old /s/<name> address to the skill in the default project", async () => {
    const res = await SELF.fetch(`${ORIGIN}/s/demo-skill`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/p/default/s/demo-skill");
  });

  it("keeps the original query string across the legacy redirect", async () => {
    const res = await SELF.fetch(`${ORIGIN}/s/demo-skill?v=2`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/p/default/s/demo-skill?v=2");
  });

  it("encodes an unsafe slug in the legacy redirect instead of erroring", async () => {
    const res = await SELF.fetch(`${ORIGIN}/s/a%0d%0ab`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/p/default/s/a%0D%0Ab");
  });

  it("hides a private skill from anonymous visitors", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    expect((await SELF.fetch(`${ORIGIN}/p/default/s/other-skill`)).status).toBe(404);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await SELF.fetch(`${ORIGIN}/p/default/s/nope`)).status).toBe(404);
  });

  it("shows a grouped download count in the Details panel to a signed-in user", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    await incrementDownloads(env.DB, "default", "demo-skill");

    let html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: cookie } })).text();
    expect(details(html)).toMatch(/<dt class="cf-row-label">Downloads<\/dt>\s*<dd class="cf-row-value">1<\/dd>/);

    await env.DB.prepare("UPDATE skills SET download_count = 1234 WHERE slug = 'demo-skill'").run();
    html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: cookie } })).text();
    expect(details(html)).toContain('<dd class="cf-row-value">1,234</dd>');
  });

  it("hides download counts from anonymous visitors", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");

    expect(await (await SELF.fetch(`${ORIGIN}/`)).text()).not.toMatch(COUNT_TEXT);
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`)).text();
    expect(html).not.toMatch(COUNT_TEXT);
    expect(details(html)).not.toContain("Downloads");
  });
});

describe("downloads", () => {
  beforeEach(resetDb);

  it("serves the latest version as an attachment", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("demo-skill.zip");
  });

  it("serves a specific version", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "public");
    const res = await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill/v/1/download`);
    expect(res.status).toBe(200);
  });

  it("refuses to serve a private skill to anonymous visitors", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, OTHER_MD, "private");
    expect((await SELF.fetch(`${ORIGIN}/p/default/s/other-skill/download`)).status).toBe(404);
  });
});

describe("visibility and deletion", () => {
  beforeEach(resetDb);

  it("toggles visibility", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    await postForm("/p/default/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
    await postForm("/p/default/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("private");
  });

  it("deletes the skill and its r2 objects", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    const key = (await getVersion(env.DB, "default", "demo-skill", 1))!.r2_key;
    expect(await env.BUCKET.get(key)).not.toBeNull();
    const res = await postForm("/p/default/s/demo-skill/delete", cookie);
    expect(res.status).toBe(302);
    expect(await getSkill(env.DB, "default", "demo-skill")).toBeNull();
    expect(await env.BUCKET.get(key)).toBeNull();
  });

  it("puts skill deletion behind a confirm step that names the skill", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    await publish(cookie, GOOD_MD, "private");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: cookie } })).text();

    const blocks = html.match(/<div class="cf-toolbar-group cf-toolbar-end"><details class="cf-confirm">[\s\S]*?<\/details>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/<summary class="cf-btn cf-btn-ghost cf-btn-ghost-danger"><svg [^>]*>[\s\S]*?<\/svg>Delete<\/summary>/);
    expect(blocks[0]).toContain(`<p class="cf-hint">Deleting removes demo-skill and all of its versions.`);
    expect(blocks[0]).toContain(`action="/p/default/s/demo-skill/delete"`);
    expect(blocks[0]).toContain(`<button type="submit" class="cf-btn cf-btn-danger">Delete demo-skill</button>`);
    expect(html.split("/p/default/s/demo-skill/delete")).toHaveLength(2);
  });

  it("stops a member touching another user's skill", async () => {
    const alice = await seedAndLogin({ username: "alice" });
    await publish(alice.cookie, GOOD_MD, "private");
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    expect((await postForm("/p/default/s/demo-skill/visibility", cookie)).status).toBe(403);
    expect((await postForm("/p/default/s/demo-skill/delete", cookie)).status).toBe(403);
  });
});

describe("home page hero", () => {
  beforeEach(resetDb);

  const homeOf = async (path: string, cookie?: string) =>
    (await SELF.fetch(`${ORIGIN}${path}`, cookie ? { headers: { Cookie: cookie } } : {})).text();
  const heroOf = (html: string) => /<section class="cf-hero"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const MEMBER_LEDE =
    'Each project you are in has your install command on its page, listed under <a href="/projects">Projects</a>, and so do its skills.';
  const expectNoCommand = (hero: string) => {
    expect(hero).toContain('<h1 id="hero-title" class="cf-hero-title">Find a skill to install</h1>');
    expect(hero).toContain('<form method="get" action="/" class="cf-search" role="search">');
    expect(hero).not.toContain("cf-command");
    expect(hero).not.toContain("npx skills add");
  };

  it("shows no install command to an anonymous visitor, and says where the commands are", async () => {
    const hero = heroOf(await homeOf("/"));
    expectNoCommand(hero);
    expect(hero).toContain("Every skill has its install command on its page, and public skills need no key.");
    expect(hero).toContain('<a href="/login">Sign in</a> to see the private ones.');
  });

  it("shows no install command on a search of the home page", async () => {
    expectNoCommand(heroOf(await homeOf("/?q=zzz")));
  });

  it("shows no install command to a user in one project, and points to the project pages", async () => {
    const { cookie } = await seedAndLogin({ username: "alice" });
    const html = await homeOf("/", cookie);
    const hero = heroOf(html);
    expectNoCommand(hero);
    expect(hero).toContain(MEMBER_LEDE);
    expect(html).not.toContain("/i/");
  });

  it("tells an instance admin only about the projects they are in, though they see other projects' private skills", async () => {
    await seedProject("team-b", "Team B");
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
    await publish(bob.cookie, GOOD_MD, "private", "team-b");
    const root = await seedAndLogin({ username: "root", role: "admin" });

    const html = await homeOf("/", root.cookie);
    expect(html).toContain('href="/p/team-b/s/demo-skill"');
    expect(heroOf(html)).toContain(MEMBER_LEDE);
  });

  it("shows no install command or key anywhere on the page to a user in several projects", async () => {
    await seedProject("team-b", "Team B");
    const { user, cookie } = await seedAndLogin({ username: "alice" });
    await joinProject(user.id, "team-b", "b".repeat(32));

    const html = await homeOf("/", cookie);
    expectNoCommand(heroOf(html));
    expect(html).not.toContain("npx skills add");
    expect(html).not.toContain("/i/");
    expect(html).not.toContain(await installKey(user.id));
    expect(html).not.toContain("b".repeat(32));
  });

  it("shows no install command to a user in no project", async () => {
    const { cookie } = await seedAndLogin({ username: "alice", project: null });
    const hero = heroOf(await homeOf("/", cookie));
    expectNoCommand(hero);
    expect(hero).toContain(
      "You are not in a project yet, so you have no install key. Every public skill has its install command on its page.",
    );
  });
});

describe("project visibility", () => {
  beforeEach(resetDb);

  async function twoProjects() {
    await seedProject("team-b", "Team B");
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-b" });
    return { alice, bob };
  }

  it("keeps another project's private skill out of a member's list and search", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "private");
    for (const path of ["/", "/?q=demo"]) {
      const html = await (await SELF.fetch(`${ORIGIN}${path}`, { headers: { Cookie: bob.cookie } })).text();
      expect(html, path).not.toContain("demo-skill");
    }
  });

  it("answers 404, never 403, to every page, download and form of another project's private skill", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "private");
    const base = "/p/default/s/demo-skill";
    for (const path of [base, `${base}?v=1`, `${base}/download`, `${base}/v/1/download`, `${base}/edit`, `${base}/upload`]) {
      expect((await SELF.fetch(`${ORIGIN}${path}`, { headers: { Cookie: bob.cookie } })).status, path).toBe(404);
    }
    for (const path of [`${base}/visibility`, `${base}/delete`]) {
      expect((await postForm(path, bob.cookie)).status, path).toBe(404);
    }
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("shows another project's public skill to everyone but lets only its project manage it", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "public");
    const html = await (await SELF.fetch(`${ORIGIN}/`, { headers: { Cookie: bob.cookie } })).text();
    expect(html).toContain("demo-skill");
    expect((await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: bob.cookie } })).status).toBe(200);
    expect((await postForm("/p/default/s/demo-skill/visibility", bob.cookie)).status).toBe(403);
  });

  it("shows an instance admin in no project every private skill, and lets them manage it", async () => {
    const { alice } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "private");
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });
    const html = await (await SELF.fetch(`${ORIGIN}/`, { headers: { Cookie: root.cookie } })).text();
    expect(html).toContain("demo-skill");
    expect((await postForm("/p/default/s/demo-skill/visibility", root.cookie)).status).toBe(302);
  });

  it("lets a project admin manage a skill another member owns", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private");
    const lead = await seedAndLogin({ username: "lead", role: "member", projectRole: "admin" });
    expect((await postForm("/p/default/s/demo-skill/visibility", lead.cookie)).status).toBe(302);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
  });

  it("takes a private skill away from its owner once they leave the project", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private");
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(alice.user.id).run();
    expect((await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: alice.cookie } })).status).toBe(404);
    expect((await postForm("/p/default/s/demo-skill/delete", alice.cookie)).status).toBe(404);
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });
});

describe("moving a skill", () => {
  beforeEach(resetDb);

  const inTwoProjects = async (username = "alice") => {
    await seedProject("team-b", "Team B");
    const login = await seedAndLogin({ username, role: "member" });
    await joinProject(login.user.id, "team-b");
    return login;
  };
  const indexNames = async (key: string) =>
    (
      await (await SELF.fetch(`${ORIGIN}/i/${key}/.well-known/agent-skills/index.json`)).json<{
        skills: Array<{ name: string }>;
      }>()
    ).skills.map((s) => s.name);

  it("moves a skill with its versions and downloads, and the keys follow it", async () => {
    const alice = await inTwoProjects();
    await publish(alice.cookie, GOOD_MD, "private", "default");
    await publish(alice.cookie, `${GOOD_MD}\nv2\n`, "private", "default");
    await incrementDownloads(env.DB, "default", "demo-skill");

    const res = await postForm("/p/default/s/demo-skill/move", alice.cookie, { project: "team-b" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/team-b/s/demo-skill");
    expect(await getSkill(env.DB, "default", "demo-skill")).toBeNull();
    expect(await getSkill(env.DB, "team-b", "demo-skill")).toMatchObject({ latest_version: 2, download_count: 1 });
    expect((await SELF.fetch(`${ORIGIN}/p/team-b/s/demo-skill/v/1/download`, { headers: { Cookie: alice.cookie } })).status).toBe(200);
    expect(await indexNames(await installKey(alice.user.id))).toEqual([]);
    expect(await indexNames(await installKey(alice.user.id, "team-b"))).toEqual(["demo-skill"]);
  });

  it("offers the other projects without a skill of that name in a Move control", async () => {
    const alice = await inTwoProjects();
    await seedProject("team-c", "Team C");
    await joinProject(alice.user.id, "team-c");
    await publish(alice.cookie, GOOD_MD, "private", "default");
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-c" });
    await publish(bob.cookie, GOOD_MD, "private");

    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: alice.cookie } })).text();
    const block = /<details class="cf-confirm cf-move">[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(block).toContain('action="/p/default/s/demo-skill/move"');
    expect([...block.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["team-b", "Team B"],
    ]);
  });

  it("shows no Move control when there is nowhere to move to", async () => {
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private", "default");
    const html = await (await SELF.fetch(`${ORIGIN}/p/default/s/demo-skill`, { headers: { Cookie: alice.cookie } })).text();
    expect(html).not.toContain("cf-move");
  });

  it("refuses a project that already has a skill of that name", async () => {
    const alice = await inTwoProjects();
    await publish(alice.cookie, GOOD_MD, "private", "default");
    await publish(alice.cookie, GOOD_MD, "private", "team-b");
    const res = await postForm("/p/default/s/demo-skill/move", alice.cookie, { project: "team-b" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("Team B already has a skill named demo-skill");
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("refuses a project the mover cannot publish to, or one that does not exist", async () => {
    await seedProject("team-b", "Team B");
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private", "default");
    for (const project of ["team-b", "nope"]) {
      expect((await postForm("/p/default/s/demo-skill/move", alice.cookie, { project })).status, project).toBe(403);
    }
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("refuses someone who cannot manage the skill", async () => {
    const alice = await inTwoProjects();
    await publish(alice.cookie, GOOD_MD, "private", "default");
    const bob = await seedAndLogin({ username: "bob", role: "member" });
    await joinProject(bob.user.id, "team-b");
    expect((await postForm("/p/default/s/demo-skill/move", bob.cookie, { project: "team-b" })).status).toBe(403);
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("lets an instance admin in no project move a skill into any project", async () => {
    await seedProject("team-b", "Team B");
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });
    const alice = await seedAndLogin({ username: "alice", role: "member" });
    await publish(alice.cookie, GOOD_MD, "private", "default");
    expect((await postForm("/p/default/s/demo-skill/move", root.cookie, { project: "team-b" })).status).toBe(302);
    expect(await getSkill(env.DB, "team-b", "demo-skill")).not.toBeNull();
  });
});
