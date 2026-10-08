import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/auth";
import { localeOf } from "../src/i18n";
import { en } from "../src/i18n/en";
import { formatCount, formatDate, formatStamp } from "../src/i18n/format";
import { ja } from "../src/i18n/ja";
import { LOCALE_COOKIE } from "../src/i18n/locales";
import { zhCN } from "../src/i18n/zh-CN";
import { zhTW } from "../src/i18n/zh-TW";
import { fetchWith, follow, GOOD_MD, ORIGIN, postForm, postMultipart, resetDb, seedAndLogin, seedAndToken, seedProject, seedUser, seedWithSkills } from "./helpers";

const htmlIn = async (path: string, headers: Record<string, string> = {}) => (await fetchWith(path, headers)).text();

const withLang = (cookie: string, locale: string) => `${cookie}; ${LOCALE_COOKIE}=${locale}`;

function leaves(value: unknown, path = ""): Array<[string, unknown]> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}

describe("catalogs", () => {
  const english = new Map(leaves(en));

  it.each([
    ["zh-CN", zhCN],
    ["zh-TW", zhTW],
    ["ja", ja],
  ])("%s has exactly the English keys, every string translated", (_name, catalog) => {
    const translated = new Map(leaves(catalog));
    expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, value] of translated) {
      const source = english.get(key);
      expect(typeof value, key).toBe(typeof source);
      if (typeof value === "string") {
        expect(value.trim(), key).not.toBe("");
        expect(value, key).not.toBe(source);
      }
    }
  });

  it.each([
    ["en", en],
    ["zh-CN", zhCN],
    ["zh-TW", zhTW],
    ["ja", ja],
  ])("%s keeps the agent prompt's command verbatim, in backticks", (_name, catalog) => {
    const command = "npx -y skills add https://example.com/.well-known/agent-skills/demo --skill demo -g -y";
    expect(catalog.skills.agentPrompt(command)).toContain(`\`${command}\``);
  });
});

describe("locale detection", () => {
  beforeEach(resetDb);

  it.each<[Record<string, string>, string]>([
    [{}, "en"],
    [{ "Accept-Language": "ja" }, "ja"],
    [{ "Accept-Language": "ja-JP,ja;q=0.9" }, "ja"],
    [{ "Accept-Language": "zh-CN,zh;q=0.9" }, "zh-CN"],
    [{ "Accept-Language": "zh" }, "zh-CN"],
    [{ "Accept-Language": "zh-SG" }, "zh-CN"],
    [{ "Accept-Language": "zh-Hans-HK" }, "zh-CN"],
    [{ "Accept-Language": "zh-TW,zh;q=0.9" }, "zh-TW"],
    [{ "Accept-Language": "zh-HK" }, "zh-TW"],
    [{ "Accept-Language": "zh-Hant" }, "zh-TW"],
    [{ "Accept-Language": "fr-FR, ja;q=0.8, en;q=0.5" }, "ja"],
    [{ "Accept-Language": "fr" }, "en"],
    [{ "Accept-Language": "ja;q=0" }, "en"],
    [{ Cookie: `${LOCALE_COOKIE}=ja`, "Accept-Language": "zh-CN" }, "ja"],
    [{ Cookie: `${LOCALE_COOKIE}=zh-TW`, "Accept-Language": "zh-CN" }, "zh-TW"],
    [{ Cookie: `${LOCALE_COOKIE}=klingon`, "Accept-Language": "zh-CN" }, "zh-CN"],
  ])("answers %o in %s", async (headers, locale) => {
    const res = await fetchWith("/", headers);
    expect(await res.text()).toContain(`<html lang="${locale}">`);
    expect(res.headers.get("Content-Language")).toBe(locale);
    expect(res.headers.get("Vary")).toContain("Accept-Language");
  });

  it("renders the layout in the detected language", async () => {
    const html = await htmlIn("/", { "Accept-Language": "ja" });
    expect(html).toContain(ja.layout.skip);
    expect(html).toContain(`<meta name="description" content="${ja.layout.tagline}"/>`);
    expect(html).toContain(`<a href="/login" class="cf-btn cf-btn-primary">${ja.layout.signIn}</a>`);
    expect(html).not.toContain(en.layout.skip);
  });

  it("gives a Hong Kong browser Traditional Chinese, not Simplified", async () => {
    const html = await htmlIn("/", { "Accept-Language": "zh-HK,zh;q=0.9" });
    expect(html).toContain(zhTW.layout.skip);
    expect(html).not.toContain(zhCN.layout.skip);
  });

  it("leaves the discovery index untouched", async () => {
    const res = await fetchWith("/.well-known/agent-skills/index.json", { "Accept-Language": "ja" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Language")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("falls back to English when nothing was detected", () => {
    expect(localeOf({ get: () => undefined } as unknown as Ctx)).toBe("en");
  });
});

describe("dates, counts and script labels", () => {
  beforeEach(resetDb);

  it("formats dates, timestamps and counts per locale", () => {
    const at = Date.UTC(2026, 8, 27, 14, 5);
    expect(formatDate("en", at)).toBe("Sep 27, 2026");
    expect(formatDate("zh-CN", at)).toBe("2026年9月27日");
    expect(formatDate("zh-TW", at)).toBe("2026年9月27日");
    expect(formatDate("ja", at)).toBe("2026年9月27日");
    expect(formatStamp("en", at)).toBe("Sep 27, 2026, 14:05 UTC");
    for (const locale of ["zh-CN", "zh-TW", "ja"] as const) {
      expect(formatStamp(locale, at)).toMatch(/^2026年9月27日 /);
      expect(formatStamp(locale, at)).toContain("14:05");
      expect(formatStamp(locale, at)).toContain("UTC");
    }
    expect(formatCount("ja", 12345)).toBe("12,345");
  });

  it("hands the copy and fold scripts their labels", async () => {
    const { cookie } = await seedWithSkills({}, [GOOD_MD, "public"]);
    const html = await htmlIn("/p/default/s/demo-skill", { Cookie: withLang(cookie, "ja") });
    const l = ja.layout;
    expect(html).toContain(
      `<body class="cf-body" data-copy-idle="${l.copy}" data-copy-done="${l.copied}" data-copy-mac="${l.pressToCopy("⌘C")}" data-copy-other="${l.pressToCopy("Ctrl+C")}" data-fold-more="${l.showMore}" data-fold-less="${l.showLess}">`,
    );
    expect(html).toContain(`<span class="cf-command-copy-label">${l.copy}</span>`);
    expect(html).toContain(`aria-expanded="false">${l.showMore}</button>`);
  });

  it("dates the users table in the viewer's language", async () => {
    const { cookie } = await seedAndLogin({ role: "admin" });
    const html = await htmlIn("/admin/users", { Cookie: withLang(cookie, "zh-CN") });
    expect(html).toMatch(/\d{4}年\d{1,2}月\d{1,2}日/);
  });
});

describe("sign-in, account and user administration", () => {
  beforeEach(resetDb);

  it("renders sign-in in Japanese and refuses a bad password in Japanese", async () => {
    await seedUser({ username: "alice" });
    expect(await htmlIn("/login", { "Accept-Language": "ja" })).toContain(ja.common.username);
    const res = await postForm("/login", null, { username: "alice", password: "wrong-password-123" }, { "Accept-Language": "ja" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(ja.auth.badCredentials);
  });

  it("carries a Chinese flash message through the cookie", async () => {
    const { cookie, password } = await seedAndLogin({ username: "alice" });
    const zh = withLang(cookie, "zh-CN");
    const res = await postForm("/me/password", zh, { current: password, next: "another-long-password" });
    expect(res.status).toBe(302);
    expect(await (await follow(res, zh)).text()).toContain(zhCN.auth.passwordChanged);
  });

  it("labels an account's settings page and roles in Chinese", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const { user: bob } = await seedUser({ username: "bob", role: "member" });
    const html = await htmlIn(`/admin/users/${bob.id}`, { Cookie: withLang(cookie, "zh-CN") });
    expect(html).toContain(zhCN.users.settingsTitle("bob"));
    expect(html).toContain(`<span class="cf-vis cf-vis-private">${zhCN.common.roles.member}</span>`);
    expect(html).toContain(zhCN.users.promote);
    expect(html).toContain(zhCN.users.installKeysHint("bob", 1, 0));
  });

  it("refuses a member at an admin page in Japanese", async () => {
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const res = await fetchWith("/admin/users", { Cookie: withLang(cookie, "ja") });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(ja.users.adminsOnly);
  });
});

describe("registry and skill pages", () => {
  beforeEach(resetDb);

  it("renders the index hero and an empty search in Japanese", async () => {
    const html = await htmlIn("/?q=%E7%84%A1", { "Accept-Language": "ja" });
    expect(html).toContain(ja.skills.hero);
    expect(html).toContain(ja.skills.noMatches("無", null));
    expect(html).toContain("<code>npx skillsgist</code>");
    expect(html).toContain(`<a href="/login">${ja.layout.signIn}</a>`);
  });

  it("renders a skill page's toolbar, details and versions in Chinese", async () => {
    const { cookie } = await seedWithSkills({ username: "alice" }, [GOOD_MD, "public"]);
    const html = await htmlIn("/p/default/s/demo-skill", { Cookie: withLang(cookie, "zh-CN") });
    for (const text of [
      zhCN.skills.downloadZip,
      zhCN.skills.makePrivate,
      zhCN.skills.deleteSkill("demo-skill"),
      zhCN.skills.latest(1),
      zhCN.skills.details,
      zhCN.skills.public,
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain(`aria-label="${zhCN.skills.downloadVersion(1)}"`);
  });

  it("refuses a move into a project the mover is not in, in Japanese", async () => {
    await seedProject("team-b", "Team B");
    const { cookie } = await seedWithSkills({ username: "bob", role: "member" }, [GOOD_MD, "private"]);
    const res = await postForm("/p/default/s/demo-skill/move", withLang(cookie, "ja"), { project: "team-b" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(ja.skills.moveForbidden);
  });

  it("refuses someone else's skill in Chinese", async () => {
    await seedWithSkills({ username: "bob", role: "member" }, [GOOD_MD, "private"]);
    const { cookie } = await seedAndLogin({ username: "carol", role: "member" });
    const res = await postForm("/p/default/s/demo-skill/delete", withLang(cookie, "zh-CN"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(zhCN.skills.notAllowed("delete"));
  });
});

describe("project pages", () => {
  beforeEach(resetDb);

  it("renders a member's project page in Japanese", async () => {
    const { cookie } = await seedAndLogin({ username: "alice", role: "member" });
    const html = await htmlIn("/p/default", { Cookie: withLang(cookie, "ja") });
    expect(html).toContain(`<a href="/p/default/settings">${ja.projects.settings}</a>`);
    expect(html).toContain(ja.skills.noSkillsYet("Default"));
  });

  it("answers settings errors and flashes in Chinese", async () => {
    const { cookie } = await seedAndLogin({ username: "root", role: "admin" });
    const zh = withLang(cookie, "zh-CN");
    const bad = await postForm("/p/default/rename", zh, { name: "" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain(zhCN.projects.nameInvalid);
    const ok = await postForm("/p/default/rename", zh, { name: "团队" });
    expect(ok.status).toBe(302);
    expect(await (await follow(ok, zh)).text()).toContain(zhCN.projects.renamed("团队"));
  });

  it("refuses a project member's admin action in Japanese", async () => {
    const { cookie } = await seedAndLogin({ username: "bob", role: "member" });
    const res = await postForm("/p/default/rename", withLang(cookie, "ja"), { name: "X" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(ja.projects.adminsOnly);
  });
});

describe("publishing", () => {
  beforeEach(resetDb);

  it("renders the publish form in Japanese", async () => {
    const { cookie } = await seedAndLogin();
    const html = await htmlIn("/new", { Cookie: withLang(cookie, "ja") });
    expect(html).toContain(ja.publish.title);
    expect(html).toContain(ja.publish.privateDetail);
    expect(html).toContain(`<span class="cf-choice-title">${ja.skills.public}</span>`);
  });

  it("explains a refused upload in Chinese", async () => {
    const { cookie } = await seedAndLogin();
    const res = await postMultipart("/new", withLang(cookie, "zh-CN"), {
      markdown: "---\nname: Bad Name\ndescription: x\n---\n",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(zhCN.publishErrors.invalidName());
  });

  it("wraps an unreadable archive's detail in Japanese", async () => {
    const { cookie } = await seedAndLogin();
    const broken = new File([new Uint8Array([0x50, 0x4b, 0x03])], "broken.zip");
    const res = await postMultipart("/new", withLang(cookie, "ja"), { file: broken });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(ja.publishErrors.unreadableArchive("Not a valid zip: file too short"));
  });

  it("names the unchanged version in Japanese on the edit page", async () => {
    const { cookie } = await seedWithSkills({}, [GOOD_MD, "private"]);
    const res = await postMultipart("/p/default/s/demo-skill/edit", withLang(cookie, "ja"), { markdown: GOOD_MD });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(ja.publishErrors.unchanged(1, "demo-skill"));
  });

  it("keeps the API's error messages in English whatever the language", async () => {
    const { token } = await seedAndToken();
    const res = await SELF.fetch(`${ORIGIN}/api/projects/default/skills/demo-skill`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/markdown",
        "Accept-Language": "ja",
        Cookie: `${LOCALE_COOKIE}=ja`,
      },
      body: "",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_upload", message: "Upload is empty" });
  });
});

describe("plain-text refusals", () => {
  beforeEach(resetDb);

  it("refuses a missing CSRF token in Chinese", async () => {
    const { cookie } = await seedAndLogin();
    const res = await SELF.fetch(`${ORIGIN}/p/default/install-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        Cookie: withLang(cookie, "zh-CN"),
      },
      body: "",
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(zhCN.errors.requestValidation);
  });
});

describe("link placeholders inside translated sentences", () => {
  beforeEach(resetDb);

  const link = (to: "upload" | "edit", text: string) =>
    `<a href="/p/default/s/demo-skill/${to}" class="cf-link">${text}</a>`;

  it.each<[string, string, string]>([
    ["ja", `など）は「${link("upload", "アーカイブをアップロード")}」を使ってください。`, `場合は「${link("edit", "編集")}」を使ってください。`],
    ["zh-CN", `请使用“${link("upload", "上传压缩包")}”。`, `请使用“${link("edit", "编辑")}”。`],
    ["zh-TW", `請使用「${link("upload", "上傳壓縮檔")}」。`, `請使用「${link("edit", "編輯")}」。`],
  ])("quotes the linked page name in %s", async (locale, editLede, uploadLede) => {
    const { cookie } = await seedWithSkills({}, [GOOD_MD, "private"]);
    expect(await htmlIn("/p/default/s/demo-skill/edit", { Cookie: withLang(cookie, locale) })).toContain(editLede);
    expect(await htmlIn("/p/default/s/demo-skill/upload", { Cookie: withLang(cookie, locale) })).toContain(uploadLede);
  });
});
