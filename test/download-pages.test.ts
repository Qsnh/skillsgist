import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { DAY_MS } from "../src/time";
import {
  appFetch, denyPublish, env, get, GOOD_MD, ORIGIN, OTHER_MD, publishMarkdown, resetDb, seedAndLogin, seedLog, seedLogs,
  seedProject, seedWithSkills, withConfig,
} from "./helpers";

const skillId = (slug: string, project = "default") => getSkill(env.db, project, slug)!.id;

const listRows = (html: string) => (html.match(/class="cf-table-date cf-log-time"/g) ?? []).length;

const chartDays = (html: string) => (html.match(/class="cf-chart-day"/g) ?? []).length;

const figure = (label: string, value: string) => new RegExp(`${label}</span><span class="cf-figure-value">${value}</span>`);

const text = async (path: string, cookie?: string) => (await get(path, cookie)).text();

async function pageWith(path: string, cookie: string, retentionDays: number): Promise<string> {
  const res = await appFetch(`${ORIGIN}${path}`, { headers: { Cookie: cookie }, env: withConfig({ retentionDays }) });
  return res.text();
}

describe("who can open the download log", () => {
  beforeEach(resetDb);

  async function cast() {
    seedProject("team-b", "Team B");
    const owner = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"]);
    const member = await seedAndLogin({ username: "bob", role: "member" });
    const projectAdmin = await seedAndLogin({ username: "carol", role: "member", projectRole: "admin" });
    const otherAdmin = await seedAndLogin({ username: "dave", role: "member", project: "team-b", projectRole: "admin" });
    const root = await seedAndLogin({ username: "root", role: "admin", project: null });
    return { owner, member, projectAdmin, otherAdmin, root };
  }

  it("opens a skill's log to whoever can manage the skill", async () => {
    const { owner, member, projectAdmin, otherAdmin, root } = await cast();
    const path = "/p/default/s/demo-skill/downloads";
    expect((await get(path)).headers.get("Location")).toBe("/login");
    expect((await get(path, owner.cookie)).status).toBe(200);
    expect((await get(path, projectAdmin.cookie)).status).toBe(200);
    expect((await get(path, root.cookie)).status).toBe(200);
    expect((await get(path, member.cookie)).status).toBe(403);
    expect((await get(path, otherAdmin.cookie)).status).toBe(404);
    expect((await get("/p/default/s/nope/downloads", root.cookie)).status).toBe(404);
    denyPublish(owner.user.id);
    expect((await get(path, owner.cookie)).status).toBe(403);
  });

  it("opens a project's log to its admins and instance admins", async () => {
    const { owner, member, projectAdmin, otherAdmin, root } = await cast();
    const path = "/p/default/downloads";
    expect((await get(path)).headers.get("Location")).toBe("/login");
    expect((await get(path, projectAdmin.cookie)).status).toBe(200);
    expect((await get(path, root.cookie)).status).toBe(200);
    expect((await get(path, owner.cookie)).status).toBe(403);
    expect((await get(path, member.cookie)).status).toBe(403);
    expect((await get(path, otherAdmin.cookie)).status).toBe(404);
    expect((await get("/p/nope/downloads", root.cookie)).status).toBe(404);
  });

  it("opens the instance log to instance admins only", async () => {
    const { projectAdmin, root } = await cast();
    expect((await get("/admin/downloads")).headers.get("Location")).toBe("/login");
    expect((await get("/admin/downloads", projectAdmin.cookie)).status).toBe(403);
    expect((await get("/admin/downloads", root.cookie)).status).toBe(200);
  });
});

describe("what the log shows", () => {
  beforeEach(resetDb);

  it("lists downloads newest first with the source, account, computer and place", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLog(id, { at: Date.now() - 2 * DAY_MS, country: "DE" });
    seedLog(id, { at: Date.now() - DAY_MS, source: "device", userId: user.id, username: "alice", deviceName: "work-laptop", country: "T1" });
    seedLog(id, { at: Date.now(), source: "device", userId: user.id, username: "alice", deviceName: "" });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(listRows(html)).toBe(3);
    expect(html.indexOf("Unnamed computer")).toBeLessThan(html.indexOf("work-laptop"));
    expect(html.indexOf("work-laptop")).toBeLessThan(html.indexOf("Germany"));
    expect(html).toContain('<span class="cf-chip cf-user-device">work-laptop</span>');
    expect(html).toContain("Tor network");
    expect(html).toContain(`href="/p/default/s/demo-skill/downloads?user=${user.id}"`);
    expect(html).toContain("3 downloads on this page, newest first.");
    expect(html).toContain('<td class="cf-log-cell cf-log-nobody">Anonymous</td>');
  });

  it("keeps a real space after the Filters label and after the time, for copied text and screen readers", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    seedLog(skillId("demo-skill"));
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toContain('<span class="cf-filters-label">Filters</span> None.');
    expect(html).toMatch(/<\/time> <span class="cf-log-zone">UTC<\/span>/);
  });

  it("shows the IP address under the place and the User-Agent under the source", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLog(id, { at: Date.now() - DAY_MS, country: "DE", ip: "203.0.113.7", userAgent: "node" });
    seedLog(id);
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toContain('<span class="cf-log-place">Germany<span class="cf-log-ip">203.0.113.7</span></span>');
    expect(html).toMatch(/Anonymous<\/a><span class="cf-log-agent" title="node">node<\/span><\/span><\/td>/);
    expect((html.match(/class="cf-log-ip"/g) ?? []).length).toBe(1);
    expect((html.match(/class="cf-log-agent"/g) ?? []).length).toBe(1);
  });

  it("credits DB-IP for the countries under the log", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    seedLog(skillId("demo-skill"), { country: "DE" });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toContain('<p class="cf-log-count">IP geolocation by <a href="https://db-ip.com" class="cf-link">DB-IP</a></p>');
  });

  it("lets an IPv6 address wrap only after a colon, and a skill's full name after its slash", async () => {
    const { cookie } = await seedWithSkills({ username: "alice", role: "admin" }, [GOOD_MD, "public"]);
    seedLog(skillId("demo-skill"), { ip: "2001:db8::7" });
    const html = await text("/admin/downloads", cookie);
    expect(html).toContain('<span class="cf-log-ip">2001:<wbr/>db8:<wbr/>:<wbr/>7</span>');
    expect(html).toContain(">Default/<wbr/>demo-skill</a>");
  });

  it("totals the last 30 days by source and version, draws one bar per day, and lists every retained row", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLog(id, { source: "web", userId: "u", username: "alice", version: 2 });
    seedLog(id);
    seedLog(id, { at: Date.now() - 3 * DAY_MS });
    seedLog(id, { at: Date.now() - 40 * DAY_MS });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(chartDays(html)).toBe(30);
    expect((html.match(/class="cf-chart-bar"/g) ?? []).length).toBe(2);
    expect(html).toMatch(figure("All downloads", "3"));
    expect(html).toMatch(figure("Web, signed in", "1"));
    expect(html).toMatch(figure("Anonymous", "2"));
    expect(html).toContain('<span class="cf-figure-percent">67%</span>');
    expect(html).toContain("Top versions");
    expect(html).toContain('<span class="cf-share-label">v1</span><span class="cf-tag">Latest</span></span><span class="cf-share-count">2</span>');
    expect(html).toContain('<span class="cf-share-label">v2</span></span><span class="cf-share-count">1</span>');
    expect(html).toContain("Busiest day: 2 on ");
    expect(listRows(html)).toBe(4);
  });

  it("never rounds a real share of downloads to 0% or 100%", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLogs(id, 299, Date.now());
    seedLog(id, { source: "web", userId: "u", username: "alice" });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toMatch(/Web, signed in<\/span>.*?<span class="cf-figure-percent">&lt;1%<\/span>/);
    expect(html).toMatch(/Anonymous<\/span>.*?<span class="cf-figure-percent">&gt;99%<\/span>/);
    expect(html).toContain('<span class="cf-share-percent">100%</span>');
  });

  it("splits the sources into whole percents that add up to 100", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLog(id, { source: "web", userId: "u", username: "alice" });
    seedLog(id, { source: "device", userId: "u", username: "alice", deviceName: "mac" });
    seedLog(id, { source: "install_key", userId: "u", username: "alice" });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    const percents = [...html.matchAll(/<span class="cf-figure-percent">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(percents).toEqual(["34%", "33%", "33%", "0%"]);
  });

  it("hides the per-day table for screen readers inside a block, which a table cannot shrink to sr-only's one pixel", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLog(id);
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toContain('<div class="sr-only"><table><caption>Per day</caption>');
    expect(html).not.toContain('<table class="sr-only">');
  });

  it("keeps a project page to its own skills, whatever the query asks for", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    seedProject("team-b", "Team B");
    await publishMarkdown(cookie, OTHER_MD, "private", "team-b");
    const foreign = skillId("other-skill", "team-b");
    seedLog(skillId("demo-skill"));
    seedLog(foreign);
    let html = await text("/p/default/downloads", cookie);
    expect(listRows(html)).toBe(1);
    expect(html).not.toContain("other-skill");
    html = await text(`/p/default/downloads?skill=${foreign}`, cookie);
    expect(html).toContain("No downloads to show");
    expect(html).not.toContain("other-skill");
    html = await text("/admin/downloads?project=team-b", cookie);
    expect(listRows(html)).toBe(1);
    expect(html).toContain("Team B/<wbr/>other-skill");
    expect(html).toContain("Project: Team B");
    html = await text(`/p/default/s/demo-skill/downloads?skill=${foreign}&project=team-b`, cookie);
    expect(listRows(html)).toBe(1);
    expect(html).not.toContain('class="cf-chip cf-filter"');
  });

  it("filters by account, skill and source, and ignores values it does not know", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"], [OTHER_MD, "private"]);
    const demo = skillId("demo-skill");
    const other = skillId("other-skill");
    seedLog(demo, { source: "web", userId: user.id, username: "alice" });
    seedLog(demo, { source: "web", userId: user.id, username: "alice" });
    seedLog(other, { source: "install_key", userId: "bob-id", username: "bob" });
    seedLog(demo);
    const base = "/p/default/downloads";

    let html = await text(`${base}?user=${user.id}`, cookie);
    expect(listRows(html)).toBe(2);
    expect(html).toContain("Account: alice");
    expect(html).toMatch(/<a href="\/p\/default\/downloads" class="cf-chip cf-filter" aria-label="Remove Account: alice">/);

    expect(listRows(await text(`${base}?source=install_key`, cookie))).toBe(1);

    html = await text(`${base}?skill=${demo}&source=anonymous`, cookie);
    expect(listRows(html)).toBe(1);
    expect(html).toContain("Skill: demo-skill");
    expect(html).toContain("Source: Anonymous");
    expect(html).toContain("Clear all");

    html = await text(`${base}?user=${user.id}&skill=${other}`, cookie);
    expect(html).toContain("No downloads to show");
    expect(html).toContain("Account: alice");
    expect(html).toContain("Skill: other-skill");
    html = await text(`/admin/downloads?skill=${other}&before=1`, cookie);
    expect(listRows(html)).toBe(0);
    expect(html).toContain("Skill: Default/other-skill");

    for (const junk of ["?source=bogus", "?user=%27%3B%20DROP%20TABLE%20skills", "?before=abc", "?before=0"]) {
      html = await text(`${base}${junk}`, cookie);
      expect(listRows(html), junk).toBe(4);
      expect(html, junk).not.toContain('class="cf-chip cf-filter"');
      expect(html, junk).toContain("None. Select a source");
    }
  });

  it("pages 50 at a time, keeping the filters, and survives a stale cursor", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    seedLogs(skillId("demo-skill"), 55, Date.now());
    const base = "/p/default/s/demo-skill/downloads";
    const first = await text(`${base}?source=anonymous`, cookie);
    expect(listRows(first)).toBe(50);
    expect(first).toContain(
      `<a href="${base}?source=anonymous" class="cf-figure" aria-current="true"><span class="cf-figure-label">Anonymous</span><span class="cf-figure-value">55</span>`,
    );
    expect(first).toMatch(figure("All downloads", "—"));
    expect(first).toContain(`<a href="${base}" class="cf-figure cf-figure-all"><span`);
    const older = /href="\/p\/default\/s\/demo-skill\/downloads\?source=anonymous&amp;before=(\d+)"/.exec(first);
    expect(older).not.toBeNull();
    const second = await text(`${base}?source=anonymous&before=${older![1]}`, cookie);
    expect(listRows(second)).toBe(5);
    expect(second).toContain(`href="${base}?source=anonymous" class="cf-btn cf-btn-outline cf-btn-sm">Newest</a>`);
    expect(second).not.toContain(">Older</a>");
    const stale = await text(`${base}?before=1`, cookie);
    expect(listRows(stale)).toBe(0);
    expect(stale).toContain("All downloads");
    expect(stale).toContain(">Newest</a>");
  });

  it("hides downloads older than the retention period, from the list and from the totals", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    seedLog(id, { at: Date.now() - 91 * DAY_MS });
    seedLog(id, { at: Date.now() - 89 * DAY_MS });
    seedLog(id, { at: Date.now() - 8 * DAY_MS });
    seedLog(id, { at: Date.now() - 6 * DAY_MS });
    expect(listRows(await text("/p/default/s/demo-skill/downloads", cookie))).toBe(3);
    const html = await pageWith("/p/default/s/demo-skill/downloads", cookie, 7);
    expect(listRows(html)).toBe(1);
    expect(html).toMatch(figure("All downloads", "1"));
    expect(html).toContain("in the last 7 days.");
  });

  it("lists the same UTC days that the totals count when the retention period is shorter than 30 days", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = skillId("demo-skill");
    const firstDay = (Math.floor(Date.now() / DAY_MS) - 6) * DAY_MS;
    seedLog(id, { at: firstDay - 1 });
    seedLog(id, { at: firstDay });
    const html = await pageWith("/p/default/s/demo-skill/downloads", cookie, 7);
    expect(listRows(html)).toBe(1);
    expect(html).toMatch(figure("All downloads", "1"));
  });

  it("narrows the chart and its label to the retention period when that is shorter than 30 days", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    seedLog(skillId("demo-skill"), { at: Date.now() - 2 * DAY_MS });
    const html = await pageWith("/p/default/s/demo-skill/downloads", cookie, 7);
    expect(chartDays(html)).toBe(7);
    expect(html).toContain("Last 7 days");
    expect(html).not.toContain("Last 30 days");
    expect(await text("/p/default/s/demo-skill/downloads", cookie)).toContain("Last 30 days");
  });

  it("says day rather than days when the logs are kept for one day", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    let html = await pageWith("/p/default/s/demo-skill/downloads", cookie, 1);
    expect(html).toContain("in the last 1 day.");
    expect(html).toContain("are kept for 1 day.");
    expect(html).not.toContain("1 days");
    seedLog(skillId("demo-skill"));
    html = await pageWith("/p/default/s/demo-skill/downloads", cookie, 1);
    expect(html).toContain("Last 1 day<");
    expect(html).toContain("in the last 1 day.");
    expect(html).not.toContain("1 days");
  });

  it("keeps the way back to the newest page when a stale cursor lands on an empty page", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    seedLog(skillId("demo-skill"), { at: Date.now() - 40 * DAY_MS });
    const html = await text("/p/default/s/demo-skill/downloads?before=1", cookie);
    expect(html).not.toContain("No downloads to show");
    expect(html).toContain("No downloads on this page.");
    expect(html).toContain('href="/p/default/s/demo-skill/downloads" class="cf-btn cf-btn-outline cf-btn-sm">Newest</a>');
  });

  it("escapes names it did not write", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    seedProject("team-b", "<b>Team</b>");
    await publishMarkdown(cookie, OTHER_MD, "public", "team-b");
    seedLog(skillId("other-skill", "team-b"), {
      source: "device",
      userId: user.id,
      username: "alice",
      deviceName: "<i>laptop</i>",
      userAgent: '"><u>agent</u>',
    });
    const html = await text("/admin/downloads", cookie);
    expect(html).toContain("&lt;b&gt;Team&lt;/b&gt;/<wbr/>other-skill");
    expect(html).toContain("&lt;i&gt;laptop&lt;/i&gt;");
    expect(html).toContain('title="&quot;&gt;&lt;u&gt;agent&lt;/u&gt;">&quot;&gt;&lt;u&gt;agent&lt;/u&gt;</span>');
    expect(html).not.toContain("<b>Team</b>");
    expect(html).not.toContain("<i>laptop</i>");
    expect(html).not.toContain("<u>agent</u>");
  });

  it("shows an empty state when nothing was downloaded", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toContain("No downloads to show");
    expect(html).toContain("Downloads appear here as they happen and are kept for 90 days.");
    expect(html).not.toContain("<rect ");
  });
});

describe("links to the download log", () => {
  beforeEach(resetDb);

  it("links the download count to the skill's log only for those who can manage the skill", async () => {
    const owner = await seedWithSkills({ username: "alice", role: "member" }, [GOOD_MD, "private"]);
    const member = await seedAndLogin({ username: "bob", role: "member" });
    expect(await text("/p/default/s/demo-skill", owner.cookie)).toContain(
      '<a href="/p/default/s/demo-skill/downloads" class="cf-row-link">0</a>',
    );
    const html = await text("/p/default/s/demo-skill", member.cookie);
    expect(html).not.toContain('/s/demo-skill/downloads"');
    expect(html).toMatch(/<dt class="cf-row-label">Downloads<\/dt>\s*<dd class="cf-row-value">0<\/dd>/);
  });

  it("offers a project's log on its settings page to its admins only", async () => {
    const projectAdmin = await seedAndLogin({ username: "carol", role: "member", projectRole: "admin" });
    const member = await seedAndLogin({ username: "bob", role: "member" });
    expect(await text("/p/default/settings", projectAdmin.cookie)).toContain('href="/p/default/downloads"');
    expect(await text("/p/default/settings", member.cookie)).not.toContain('href="/p/default/downloads"');
  });

  it("lists the instance log in the account menu for instance admins only", async () => {
    const root = await seedAndLogin({ username: "root", role: "admin" });
    const member = await seedAndLogin({ username: "bob", role: "member" });
    expect(await text("/me", root.cookie)).toContain('<a href="/admin/downloads" class="cf-menu-item">Downloads</a>');
    expect(await text("/me", member.cookie)).not.toContain('href="/admin/downloads"');
  });
});
