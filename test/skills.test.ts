import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill, getVersion, incrementDownloads, updateVersionHtml } from "../src/db/queries";
import { en } from "../src/i18n/en";
import { LOCALE_COOKIE } from "../src/i18n/locales";
import { zhCN } from "../src/i18n/zh-CN";
import { RENDER_REVISION } from "../src/render/markdown";
import {
  cellMeta, denyPublish, env, get, indexAt, indexNames, installKey, joinProject, ORIGIN, OTHER_MD, postForm,
  publishMarkdown as publish, resetDb, seedAndLogin, seedProject, seedWithSkills, twoProjects,
} from "./helpers";

// This file asserts the rendered body reaches the page, so it wants a heading
// it can look for — the shared GOOD_MD's is just "# Demo".
const GOOD_MD = "---\nname: demo-skill\ndescription: A demo skill used by the test suite.\n---\n\n# Demo Heading\n";

const COUNT_TEXT = /\d[\d,]* downloads?\b/;

const details = (html: string) => /<dl class="cf-rows">([\s\S]*?)<\/dl>/.exec(html)?.[1];

const COMMAND_KEY_NOTE =
  '<p class="cf-install-note">This command carries your install key for Default, and installing into a code repository also records the key in its skills-lock.json. Keep both out of shared chats and public repositories, and reset the key under <a href="/p/default/settings">Settings</a> if it leaks.</p>';

describe("GET /", () => {
  beforeEach(resetDb);

  it("shows only public skills to anonymous visitors", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);

    const html = await (await get("/")).text();
    expect(html).toContain("demo-skill");
    expect(html).not.toContain("other-skill");
  });

  it("shows a signed-in user their private skills, with a grouped download count in each cell", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    const home = async () => (await get("/", cookie)).text();
    const html = await home();
    expect(html).toContain("other-skill");
    expect(cellMeta(html)).toContain("alice");
    expect(cellMeta(html)).toContain("0 downloads");

    await env.DB.prepare("UPDATE skills SET download_count = 1234 WHERE slug = 'other-skill'").run();
    expect(cellMeta(await home())).toContain("1,234 downloads");
  });

  it("filters by query", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "public"]);
    const html = await (await get("/?q=other")).text();
    expect(html).toContain("other-skill");
    expect(html).not.toContain(">Default/demo-skill<");
  });

  it("titles each cell with its project's name and its own", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "public");
    await publish(bob.cookie, GOOD_MD, "public");
    const html = await (await get("/")).text();
    expect(html).toContain('<a href="/p/default/s/demo-skill" class="cf-cell-link">Default/demo-skill</a>');
    expect(html).toContain('<a href="/p/team-b/s/demo-skill" class="cf-cell-link">Team B/demo-skill</a>');
  });

  it("shows only the author in a cell's meta row", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await (await get("/")).text();
    const meta = cellMeta(html);
    expect(meta).toContain("<span>alice</span>");
    expect(meta).not.toContain("Default");
    expect(meta).not.toContain("v1");
    expect(meta).not.toContain("<time");
  });
});

describe("GET /p/:project/s/:slug", () => {
  beforeEach(resetDb);

  it("shows the project, author and visibility but no version or date in the Details panel, not on the orange panel", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await (await get("/p/default/s/demo-skill")).text();
    expect(html).toContain('<h2 class="cf-panel-title">Details</h2>');
    const meta = details(html);
    expect(meta).toContain('<a href="/p/default" class="cf-row-link">Default</a>');
    expect(meta).toContain('<dd class="cf-row-value">alice</dd>');
    expect(meta).toContain("Public");
    expect(meta).not.toContain("v1");
    expect(meta).not.toContain("<time");
    const hero = /<section class="cf-hero"[\s\S]*?<\/section>/.exec(html)?.[0];
    expect(hero).not.toContain("alice");
    expect(hero).not.toContain("cf-vis");
  });

  it("re-renders html stored by an older renderer and saves it", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<hr>\n<h2>name: demo-skill</h2>", 0);

    const html = await (await get("/p/default/s/demo-skill")).text();
    expect(html).not.toContain("name: demo-skill</h2>");
    expect(html).toContain("Demo Heading");

    const row = await getVersion(env.DB, "default", "demo-skill", 1);
    expect(row?.html_rev).toBe(RENDER_REVISION);
    expect(row?.html).toContain("Demo Heading");
  });

  it("heals an older version viewed with ?v=", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [GOOD_MD.replace("Demo Heading", "Second Heading"), "public"]);
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<h2>stale</h2>", 0);

    const html = await (await get("/p/default/s/demo-skill?v=1")).text();
    expect(html).not.toContain("stale");
    expect(html).toContain("Demo Heading");
  });

  it("still serves a healed page when saving the re-rendered html fails", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<h2>stale</h2>", 0);
    await env.DB.prepare(
      "CREATE TRIGGER reject_html_write BEFORE UPDATE OF html ON versions BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    ).run();

    try {
      const res = await get("/p/default/s/demo-skill");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("stale");
      expect(html).toContain("Demo Heading");
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_html_write").run();
    }
  });

  it("serves current html from storage without re-rendering", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await updateVersionHtml(env.DB, "default", "demo-skill", 1, "<p>stored-sentinel</p>", RENDER_REVISION);

    const html = await (await get("/p/default/s/demo-skill")).text();
    expect(html).toContain("stored-sentinel");
  });

  it("renders fold hooks with hidden Show more toggles, and a hidden copy button instead of the select hint", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await (await get("/p/default/s/demo-skill")).text();
    const showMore = (id: string) =>
      `<footer class="cf-fold-foot" hidden=""><button type="button" class="cf-btn cf-btn-outline cf-btn-sm" aria-controls="${id}" aria-expanded="false">Show more</button></footer>`;
    expect(html).toContain(`<div id="skill-doc" class="skill-doc" data-fold="true">`);
    expect(html).toContain(showMore("skill-doc"));
    for (const id of ["skill-files", "skill-versions"]) {
      expect(html).toContain(`<ul id="${id}" class="cf-rows" data-fold="true">`);
      expect(html).toContain(`</ul>${showMore(id)}</section>`);
    }
    expect(html).toContain(`<div class="cf-command cf-command-raised" data-copy="true">`);
    expect(html).toContain(`<button type="button" class="cf-command-copy" hidden="">`);
    expect(html).toContain(`<span class="cf-command-copy-label">Copy</span>`);
    expect(html).toContain(`<span class="cf-command-status sr-only" role="status"></span>`);
    expect(html).not.toContain("Click to select");
  });

  // Pull the URL out of the rendered output rather than rebuilding it here —
  // what these two cases verify is precisely that *the one shown on the page*
  // works, and rebuilding it would reimplement the thing under test, so a
  // change to the view would not turn them red.
  // The whole html comes back alongside it, so "an anonymous page must not
  // contain /i/" can keep asserting against the full page.
  const installCommandOn = async (path: string, cookie?: string) => {
    const res = await get(path, cookie);
    const html = await res.text();
    const url = /npx skills add ([^<\s]+)/.exec(html)?.[1];
    if (!url) throw new Error(`${path} rendered no install command (status ${res.status})`);
    return { url, html };
  };

  const promptOn = async (path: string, cookie?: string) => {
    const html = await (await get(path, cookie)).text();
    const match = /npx -y skills add (\S+) --skill (\S+) -g -y/.exec(html);
    if (!match) throw new Error(`${path} rendered no install prompt`);
    return { command: match[0], url: match[1], skill: match[2], html };
  };

  // Walk the displayed address the way the CLI actually does: append a
  // .well-known layer, fetch the index, then fetch entry.url. The index must
  // hold *only* this skill — `skills add` installs every entry it finds, so one
  // extra entry is one extra skill installed.
  //
  // Both cases publish two skills: with only one, an un-narrowed index would
  // also hold exactly one entry and the assertion would pass anyway.
  it("shows an anonymous install command that resolves to just this skill", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "public"]);

    const { url, html } = await installCommandOn("/p/default/s/demo-skill");
    expect(url).toBe(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
    expect(html).not.toContain("/i/");
    expect(html).not.toContain("cf-install-note");

    const skills = await indexAt(url.slice(ORIGIN.length));
    expect(skills.map((s) => s.name)).toEqual(["demo-skill"]);
    expect((await SELF.fetch(skills[0].url)).status).toBe(200);
  });

  it("shows a member a keyed install command, on public and private skills alike, that resolves to just this skill", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const key = await installKey(user.id);

    const { url, html } = await installCommandOn("/p/default/s/other-skill", cookie);
    expect(url).toBe(`${ORIGIN}/i/${key}/.well-known/agent-skills/other-skill`);
    expect(html).not.toContain("cf-hero-note");
    const demo = await installCommandOn("/p/default/s/demo-skill", cookie);
    expect(demo.url).toBe(`${ORIGIN}/i/${key}/.well-known/agent-skills/demo-skill`);
    expect(demo.html).toContain("SKILL.md");

    const skills = await indexAt(url.slice(ORIGIN.length));
    expect(skills.map((s) => s.name)).toEqual(["other-skill"]);
    expect((await SELF.fetch(skills[0].url)).status).toBe(200);
  });

  it("shows the project's public address to a signed-in user outside a public skill's project", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "public");

    const { url, html } = await installCommandOn("/p/default/s/demo-skill", bob.cookie);
    expect(url).toBe(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
    expect(html).not.toContain("cf-hero-note");
    expect(html).not.toContain("cf-install-note");
  });

  it("offers an agent prompt that installs one skill with skills add, globally and without a question from npx or the CLI", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const key = await installKey(user.id);

    const anon = await promptOn("/p/default/s/demo-skill");
    expect(anon.url).toBe((await installCommandOn("/p/default/s/demo-skill")).url);
    expect(anon.skill).toBe("demo-skill");
    expect(anon.html).not.toContain("/i/");

    const member = await promptOn("/p/default/s/other-skill", cookie);
    expect(member.url).toBe(`${ORIGIN}/i/${key}/.well-known/agent-skills/other-skill`);
    expect(member.command).toBe(`npx -y skills add ${member.url} --skill other-skill -g -y`);
    expect(member.html).toContain(en.skills.agentPrompt(member.command));
    expect(member.html).not.toMatch(/skills(@\S+)? use /);
    const skills = await indexAt(member.url.slice(ORIGIN.length));
    expect(skills.map((s) => s.name)).toEqual([member.skill]);
  });

  it("warns under every box that carries a member's install key, and keeps the key out of a public skill's prompt", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [OTHER_MD, "private"]);
    const key = await installKey(user.id);

    const open = await promptOn("/p/default/s/demo-skill", cookie);
    expect((await installCommandOn("/p/default/s/demo-skill", cookie)).url).toContain(`/i/${key}/`);
    expect(open.html).toContain(`${COMMAND_KEY_NOTE}</div><div id="install-prompt" data-mode="prompt" role="group" aria-label="Prompt">`);
    expect(open.url).toBe(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
    expect(open.html.split('data-mode="prompt"')[1]).not.toContain("cf-install-note");

    const closed = await promptOn("/p/default/s/other-skill", cookie);
    expect(closed.url).toContain(`/i/${key}/`);
    expect(closed.html).toContain(`${COMMAND_KEY_NOTE}</div><div id="install-prompt" data-mode="prompt" role="group" aria-label="Prompt">`);
    expect(closed.html).toContain(
      '<p class="cf-install-note">This prompt carries your install key for Default. Paste it only into an agent you trust, and reset the key under <a href="/p/default/settings">Settings</a> if it leaks.</p></div></div>',
    );
  });

  it("switches between command and prompt with a native radio pair, command first and the prompt without a $", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await (await get("/p/default/s/demo-skill")).text();
    expect(html).toContain('<legend class="sr-only">Install with</legend>');
    expect(html).toMatch(/<input type="radio" name="install-mode" value="command"[^>]*checked/);
    expect(html).toMatch(/<input type="radio" name="install-mode" value="prompt"(?![^>]*checked)[^>]*>Prompt/);
    expect(html).toContain(
      '<div id="install-command" data-mode="command" role="group" aria-label="Command"><div class="cf-command cf-command-raised" data-copy="true"><span class="cf-command-prompt" aria-hidden="true">$</span>',
    );
    expect(html).toContain(
      '<div id="install-prompt" data-mode="prompt" role="group" aria-label="Prompt"><div class="cf-command cf-command-raised" data-copy="true"><code class="cf-command-text">Run `npx -y skills add ',
    );
  });

  it("ties each radio to the box it shows and names both boxes for screen readers", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await (await get("/p/default/s/demo-skill")).text();
    expect(html).toMatch(/<input type="radio" name="install-mode" value="command"[^>]*aria-controls="install-command"/);
    expect(html).toMatch(/<input type="radio" name="install-mode" value="prompt"[^>]*aria-controls="install-prompt"/);
    expect(html).toContain('<div id="install-command" data-mode="command" role="group" aria-label="Command">');
    expect(html).toContain('<div id="install-prompt" data-mode="prompt" role="group" aria-label="Prompt">');
  });

  it("words the agent prompt in the reader's language and keeps the command verbatim", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const { command, html } = await promptOn("/p/default/s/demo-skill", `${LOCALE_COOKIE}=zh-CN`);
    expect(html).toContain(zhCN.skills.agentPrompt(command));
    expect(html).toContain('<legend class="sr-only">安装方式</legend>');
  });

  it("offers only the install command on an older version's page, since the prompt would run the latest", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"], [GOOD_MD.replace("Demo Heading", "Second Heading"), "public"]);

    const older = await installCommandOn("/p/default/s/demo-skill?v=1");
    expect(older.url).toBe(`${ORIGIN}/p/default/.well-known/agent-skills/demo-skill`);
    expect(older.html).not.toContain("cf-install");
    expect(older.html).not.toContain("npx -y skills add");

    const keyed = await installCommandOn("/p/default/s/demo-skill?v=1", cookie);
    expect(keyed.url).toContain(`/i/${await installKey(user.id)}/`);
    expect(keyed.html).toContain(COMMAND_KEY_NOTE);
    expect(keyed.html).not.toContain("cf-install-modes");
    expect(keyed.html).not.toContain("npx -y skills add");

    const latest = await (await get("/p/default/s/demo-skill?v=2")).text();
    expect(latest).toContain("npx -y skills add");
  });

  it("shows no install command to an admin outside a private skill's project", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });

    const res = await get("/p/default/s/demo-skill", root.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("npx skills add");
    expect(html).not.toContain("cf-install");
    expect(html).not.toContain("cf-hero-note");
  });

  it("gives each project its own skill of the same name", async () => {
    const { alice, bob } = await twoProjects();
    await publish(alice.cookie, GOOD_MD, "public");
    await publish(bob.cookie, GOOD_MD.replace("Demo Heading", "Team B Heading"), "public");

    const ours = await (await get("/p/default/s/demo-skill")).text();
    const theirs = await (await get("/p/team-b/s/demo-skill")).text();
    expect(ours).toContain("Demo Heading");
    expect(theirs).toContain("Team B Heading");
    expect(details(theirs)).toContain("bob");
    expect(ours).toContain('<h1 id="skill-title" class="cf-hero-title cf-skill-title">Default/demo-skill</h1>');
    expect(theirs).toContain('<h1 id="skill-title" class="cf-hero-title cf-skill-title">Team B/demo-skill</h1>');
    expect(theirs).toContain("<title>Team B/demo-skill · skillsgist</title>");
  });

  it("no longer answers the old /s/<name> address", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    expect((await get("/p/default/s/demo-skill")).status).toBe(200);
    expect((await get("/s/demo-skill")).status).toBe(404);
  });

  it("hides a private skill from anonymous visitors behind the same 404 as an unknown slug", async () => {
    await seedWithSkills({ username: "alice" }, [OTHER_MD, "private"]);
    expect((await get("/p/default/s/other-skill")).status).toBe(404);
    expect((await get("/p/default/s/nope")).status).toBe(404);
  });

  it("shows the linked project and a grouped download count in the Details panel to a signed-in user", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    await incrementDownloads(env.DB, "default", "demo-skill");

    let html = await (await get("/p/default/s/demo-skill", cookie)).text();
    expect(details(html)).toMatch(/<dt class="cf-row-label">Downloads<\/dt>\s*<dd class="cf-row-value">1<\/dd>/);
    expect(details(html)).toContain('<a href="/p/default" class="cf-row-link">Default</a>');

    await env.DB.prepare("UPDATE skills SET download_count = 1234 WHERE slug = 'demo-skill'").run();
    html = await (await get("/p/default/s/demo-skill", cookie)).text();
    expect(details(html)).toContain('<dd class="cf-row-value">1,234</dd>');
  });

  it("hides download counts from anonymous visitors", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);

    expect(await (await get("/")).text()).not.toMatch(COUNT_TEXT);
    const html = await (await get("/p/default/s/demo-skill")).text();
    expect(html).not.toMatch(COUNT_TEXT);
    expect(details(html)).not.toContain("Downloads");
  });
});

describe("downloads", () => {
  beforeEach(resetDb);

  it("serves the latest version as an attachment", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const res = await get("/p/default/s/demo-skill/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("demo-skill.zip");
  });
});

describe("visibility and deletion", () => {
  beforeEach(resetDb);

  it("toggles visibility", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    await postForm("/p/default/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
    await postForm("/p/default/s/demo-skill/visibility", cookie);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("private");
  });

  it("deletes the skill and its r2 objects", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    const key = (await getVersion(env.DB, "default", "demo-skill", 1))!.r2_key;
    expect(await env.BUCKET.get(key)).not.toBeNull();
    const res = await postForm("/p/default/s/demo-skill/delete", cookie);
    expect(res.status).toBe(302);
    expect(await getSkill(env.DB, "default", "demo-skill")).toBeNull();
    expect(await env.BUCKET.get(key)).toBeNull();
  });

  it("puts skill deletion behind a confirm step that names the skill", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    const html = await (await get("/p/default/s/demo-skill", cookie)).text();

    const blocks = html.match(/<div class="cf-toolbar-group cf-toolbar-end"><details class="cf-confirm">[\s\S]*?<\/details>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/<summary class="cf-btn cf-btn-ghost cf-btn-ghost-danger"><svg [^>]*>[\s\S]*?<\/svg>Delete<\/summary>/);
    expect(blocks[0]).toContain(`<p class="cf-hint">Deleting removes demo-skill and all of its versions.`);
    expect(blocks[0]).toContain(`action="/p/default/s/demo-skill/delete"`);
    expect(blocks[0]).toContain(`<button type="submit" class="cf-btn cf-btn-danger">Delete demo-skill</button>`);
    expect(html.split("/p/default/s/demo-skill/delete")).toHaveLength(2);
  });

  it("stops a member touching another user's skill", async () => {
    await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    expect((await postForm("/p/default/s/demo-skill/visibility", cookie)).status).toBe(403);
    expect((await postForm("/p/default/s/demo-skill/delete", cookie)).status).toBe(403);
  });
});

describe("home page hero", () => {
  beforeEach(resetDb);

  const homeOf = async (path: string, cookie?: string) => (await get(path, cookie)).text();
  const heroOf = (html: string) => /<section class="cf-hero"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const MEMBER_LEDE =
    'Each project you are in has your install command on its page, listed under <a href="/projects">Projects</a>, and so do its skills.';
  const expectNoCommand = (hero: string) => {
    expect(hero).toContain('<h1 id="hero-title" class="cf-hero-title">Find a skill to install</h1>');
    expect(hero).toContain('<form method="get" action="/" class="cf-search" role="search">');
    expect(hero).not.toContain("cf-command");
    expect(hero).not.toContain("npx skills add");
  };

  it("shows no install command to an anonymous visitor, searching or not, and says where the commands are", async () => {
    const hero = heroOf(await homeOf("/"));
    expectNoCommand(hero);
    expect(hero).toContain("Every skill has its install command on its page, and public skills need no key.");
    expect(hero).toContain('<a href="/login">Sign in</a> to see the private ones.');
    expectNoCommand(heroOf(await homeOf("/?q=zzz")));
  });

  it("shows an instance admin in one project no install command and points to the project pages, though they see other projects' private skills", async () => {
    await seedProject("team-b", "Team B");
    await seedWithSkills({ username: "bob", role: "member", project: "team-b" }, [GOOD_MD, "private", "team-b"]);
    const root = await seedAndLogin({ username: "root", role: "admin" });

    const html = await homeOf("/", root.cookie);
    expect(html).toContain('href="/p/team-b/s/demo-skill"');
    const hero = heroOf(html);
    expectNoCommand(hero);
    expect(hero).toContain(MEMBER_LEDE);
    expect(html).not.toContain("/i/");
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

  it("keeps another project's private skill out of a member's list and search", async () => {
    const { alice, bob } = await twoProjects("member");
    await publish(alice.cookie, GOOD_MD, "private");
    for (const path of ["/", "/?q=demo"]) {
      const html = await (await get(path, bob.cookie)).text();
      expect(html, path).not.toContain("demo-skill");
    }
  });

  it("answers 404, never 403, to every page, download and form of another project's private skill", async () => {
    const { alice, bob } = await twoProjects("member");
    await publish(alice.cookie, GOOD_MD, "private");
    const base = "/p/default/s/demo-skill";
    for (const path of [base, `${base}?v=1`, `${base}/download`, `${base}/v/1/download`, `${base}/edit`, `${base}/upload`]) {
      expect((await get(path, bob.cookie)).status, path).toBe(404);
    }
    for (const path of [`${base}/visibility`, `${base}/delete`]) {
      expect((await postForm(path, bob.cookie)).status, path).toBe(404);
    }
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("shows another project's public skill to everyone but lets only its project manage it", async () => {
    const { alice, bob } = await twoProjects("member");
    await publish(alice.cookie, GOOD_MD, "public");
    const html = await (await get("/", bob.cookie)).text();
    expect(html).toContain("demo-skill");
    expect((await get("/p/default/s/demo-skill", bob.cookie)).status).toBe(200);
    expect((await postForm("/p/default/s/demo-skill/visibility", bob.cookie)).status).toBe(403);
  });

  it("shows an instance admin in no project every private skill, and lets them manage it", async () => {
    const { alice } = await twoProjects("member");
    await publish(alice.cookie, GOOD_MD, "private");
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });
    const html = await (await get("/", root.cookie)).text();
    expect(html).toContain("demo-skill");
    expect(await (await get("/?q=demo", root.cookie)).text()).toContain("demo-skill");
    expect((await postForm("/p/default/s/demo-skill/visibility", root.cookie)).status).toBe(302);
  });

  it("lets a project admin manage a skill another member owns", async () => {
    await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"]);
    const lead = await seedAndLogin({ username: "lead", role: "member", projectRole: "admin" });
    expect((await postForm("/p/default/s/demo-skill/visibility", lead.cookie)).status).toBe(302);
    expect((await getSkill(env.DB, "default", "demo-skill"))?.visibility).toBe("public");
  });

  it("takes a private skill away from its owner once they leave the project", async () => {
    const alice = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"]);
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(alice.user.id).run();
    expect((await get("/p/default/s/demo-skill", alice.cookie)).status).toBe(404);
    expect((await postForm("/p/default/s/demo-skill/delete", alice.cookie)).status).toBe(404);
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("leaves a member whose publishing is blocked seeing and installing their skill, but not managing it", async () => {
    const alice = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"]);
    await denyPublish(alice.user.id);
    const base = "/p/default/s/demo-skill";
    const page = await get(base, alice.cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(`href="${base}/edit"`);
    expect((await get(`${base}/download`, alice.cookie)).status).toBe(200);
    expect(await indexNames(`/i/${await installKey(alice.user.id)}`)).toEqual(["demo-skill"]);
    for (const path of [`${base}/edit`, `${base}/upload`]) {
      expect((await get(path, alice.cookie)).status, path).toBe(403);
    }
    for (const path of [`${base}/visibility`, `${base}/move`, `${base}/delete`]) {
      expect((await postForm(path, alice.cookie)).status, path).toBe(403);
    }
    expect(await getSkill(env.DB, "default", "demo-skill")).toMatchObject({ visibility: "private" });
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
    expect((await get("/p/team-b/s/demo-skill/v/1/download", alice.cookie)).status).toBe(200);
    expect(await indexNames(`/i/${await installKey(alice.user.id)}`)).toEqual([]);
    expect(await indexNames(`/i/${await installKey(alice.user.id, "team-b")}`)).toEqual(["demo-skill"]);
  });

  it("offers the other projects without a skill of that name in a Move control", async () => {
    const alice = await inTwoProjects();
    await seedProject("team-c", "Team C");
    await joinProject(alice.user.id, "team-c");
    await publish(alice.cookie, GOOD_MD, "private", "default");
    const bob = await seedAndLogin({ username: "bob", role: "member", project: "team-c" });
    await publish(bob.cookie, GOOD_MD, "private");

    const html = await (await get("/p/default/s/demo-skill", alice.cookie)).text();
    const block = /<details class="cf-confirm cf-move">[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(block).toContain('action="/p/default/s/demo-skill/move"');
    expect([...block.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["team-b", "Team B"],
    ]);
  });

  it("shows no Move control when there is nowhere to move to", async () => {
    const alice = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private", "default"]);
    const html = await (await get("/p/default/s/demo-skill", alice.cookie)).text();
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
    const alice = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private", "default"]);
    for (const project of ["team-b", "nope"]) {
      expect((await postForm("/p/default/s/demo-skill/move", alice.cookie, { project })).status, project).toBe(403);
    }
    expect(await getSkill(env.DB, "default", "demo-skill")).not.toBeNull();
  });

  it("neither offers nor accepts a project where the mover's publishing is blocked", async () => {
    const alice = await inTwoProjects();
    await publish(alice.cookie, GOOD_MD, "private", "default");
    await denyPublish(alice.user.id, "team-b");
    expect(await (await get("/p/default/s/demo-skill", alice.cookie)).text()).not.toContain("cf-move");
    expect((await postForm("/p/default/s/demo-skill/move", alice.cookie, { project: "team-b" })).status).toBe(403);
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
    await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private", "default"]);
    expect((await postForm("/p/default/s/demo-skill/move", root.cookie, { project: "team-b" })).status).toBe(302);
    expect(await getSkill(env.DB, "team-b", "demo-skill")).not.toBeNull();
  });
});
