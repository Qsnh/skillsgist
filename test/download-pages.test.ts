import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSkill } from "../src/db/queries";
import { app } from "../src/index";
import { DAY_MS } from "../src/retention";
import {
  denyPublish, env, envWith, get, GOOD_MD, ORIGIN, OTHER_MD, publishMarkdown, resetDb, seedAndLogin, seedLog, seedLogs,
  seedProject, seedWithSkills,
} from "./helpers";

const skillId = async (slug: string, project = "default") => (await getSkill(env.DB, project, slug))!.id;

const listRows = (html: string) => (html.match(/data-label="Time"/g) ?? []).length;

const text = async (path: string, cookie?: string) => (await get(path, cookie)).text();

async function pageWith(path: string, cookie: string, vars: Record<string, string>): Promise<string> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }), envWith(vars), ctx);
  await waitOnExecutionContext(ctx);
  return res.text();
}

describe("who can open the download log", () => {
  beforeEach(resetDb);

  async function cast() {
    await seedProject("team-b", "Team B");
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
    await denyPublish(owner.user.id);
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
    const id = await skillId("demo-skill");
    await seedLog(id, { at: Date.now() - 2 * DAY_MS, country: "DE" });
    await seedLog(id, { at: Date.now() - DAY_MS, source: "device", userId: user.id, username: "alice", deviceName: "work-laptop", country: "T1" });
    await seedLog(id, { at: Date.now(), source: "device", userId: user.id, username: "alice", deviceName: "" });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(listRows(html)).toBe(3);
    expect(html.indexOf("Unnamed computer")).toBeLessThan(html.indexOf("work-laptop"));
    expect(html.indexOf("work-laptop")).toBeLessThan(html.indexOf("Germany"));
    expect(html).toContain("Tor network");
    expect(html).toContain(`href="/p/default/s/demo-skill/downloads?user=${user.id}"`);
    expect(html).toContain("Logs are kept for 90 days.");
  });

  it("totals the last 30 days by source and version, draws one bar per day, and lists every retained row", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const id = await skillId("demo-skill");
    await seedLog(id, { source: "web", userId: "u", username: "alice", version: 2 });
    await seedLog(id);
    await seedLog(id, { at: Date.now() - 3 * DAY_MS });
    await seedLog(id, { at: Date.now() - 40 * DAY_MS });
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect((html.match(/<rect /g) ?? []).length).toBe(30);
    expect((html.match(/class="cf-chart-bar"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/All downloads<\/dt>\s*<dd class="cf-row-value">3<\/dd>/);
    expect(html).toMatch(/Web, signed in<\/a><\/dt>\s*<dd class="cf-row-value">1<\/dd>/);
    expect(html).toMatch(/Anonymous<\/a><\/dt>\s*<dd class="cf-row-value">2<\/dd>/);
    expect(html).toMatch(/<dt class="cf-row-label">v1<\/dt>\s*<dd class="cf-row-value">2<\/dd>/);
    expect(html).toContain("3 in total, at most 2 in one day.");
    expect(listRows(html)).toBe(4);
  });

  it("keeps a project page to its own skills, whatever the query asks for", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"]);
    await seedProject("team-b", "Team B");
    await publishMarkdown(cookie, OTHER_MD, "private", "team-b");
    const foreign = await skillId("other-skill", "team-b");
    await seedLog(await skillId("demo-skill"));
    await seedLog(foreign);
    let html = await text("/p/default/downloads", cookie);
    expect(listRows(html)).toBe(1);
    expect(html).not.toContain("other-skill");
    html = await text(`/p/default/downloads?skill=${foreign}`, cookie);
    expect(html).toContain("No downloads to show");
    expect(html).not.toContain("other-skill");
    html = await text("/admin/downloads?project=team-b", cookie);
    expect(listRows(html)).toBe(1);
    expect(html).toContain("Team B/other-skill");
  });

  it("filters by account, skill and source, and ignores values it does not know", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "private"], [OTHER_MD, "private"]);
    const demo = await skillId("demo-skill");
    const other = await skillId("other-skill");
    await seedLog(demo, { source: "web", userId: user.id, username: "alice" });
    await seedLog(demo, { source: "web", userId: user.id, username: "alice" });
    await seedLog(other, { source: "install_key", userId: "bob-id", username: "bob" });
    await seedLog(demo);
    const base = "/p/default/downloads";

    let html = await text(`${base}?user=${user.id}`, cookie);
    expect(listRows(html)).toBe(2);
    expect(html).toContain("Account: alice");
    expect(html).toMatch(/<a href="\/p\/default\/downloads" class="cf-tag cf-filter" aria-label="Remove Account: alice">/);

    expect(listRows(await text(`${base}?source=install_key`, cookie))).toBe(1);

    html = await text(`${base}?skill=${demo}&source=anonymous`, cookie);
    expect(listRows(html)).toBe(1);
    expect(html).toContain("Skill: demo-skill");
    expect(html).toContain("Source: Anonymous");
    expect(html).toContain("Clear all");

    for (const junk of ["?source=bogus", "?user=%27%3B%20DROP%20TABLE%20skills", "?before=abc", "?before=0"]) {
      html = await text(`${base}${junk}`, cookie);
      expect(listRows(html), junk).toBe(4);
      expect(html, junk).not.toContain('class="cf-filters"');
    }
  });

  it("pages 50 at a time, keeping the filters, and survives a stale cursor", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await seedLogs(await skillId("demo-skill"), 55, Date.now());
    const base = "/p/default/s/demo-skill/downloads";
    const first = await text(`${base}?source=anonymous`, cookie);
    expect(listRows(first)).toBe(50);
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
    const id = await skillId("demo-skill");
    await seedLog(id, { at: Date.now() - 91 * DAY_MS });
    await seedLog(id, { at: Date.now() - 89 * DAY_MS });
    await seedLog(id, { at: Date.now() - 8 * DAY_MS });
    await seedLog(id, { at: Date.now() - 6 * DAY_MS });
    expect(listRows(await text("/p/default/s/demo-skill/downloads", cookie))).toBe(3);
    const html = await pageWith("/p/default/s/demo-skill/downloads", cookie, { DOWNLOAD_LOG_RETENTION_DAYS: "7" });
    expect(listRows(html)).toBe(1);
    expect(html).toMatch(/All downloads<\/dt>\s*<dd class="cf-row-value">1<\/dd>/);
    expect(html).toContain("Logs are kept for 7 days.");
  });

  it("escapes names it did not write", async () => {
    const { user, cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    await seedProject("team-b", "<b>Team</b>");
    await publishMarkdown(cookie, OTHER_MD, "public", "team-b");
    await seedLog(await skillId("other-skill", "team-b"), { source: "device", userId: user.id, username: "alice", deviceName: "<i>laptop</i>" });
    const html = await text("/admin/downloads", cookie);
    expect(html).toContain("&lt;b&gt;Team&lt;/b&gt;/other-skill");
    expect(html).toContain("&lt;i&gt;laptop&lt;/i&gt;");
    expect(html).not.toContain("<b>Team</b>");
    expect(html).not.toContain("<i>laptop</i>");
  });

  it("shows an empty state when nothing was downloaded", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await text("/p/default/s/demo-skill/downloads", cookie);
    expect(html).toContain("No downloads to show");
    expect(html).toContain("Downloads appear here as they happen and are kept for 90 days.");
    expect(html).not.toContain("<rect ");
  });
});
