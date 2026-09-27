import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../src/auth";
import { localeOf } from "../src/i18n";
import { en } from "../src/i18n/en";
import { formatCount, formatDate, formatStamp } from "../src/i18n/format";
import { ja } from "../src/i18n/ja";
import { zhCN } from "../src/i18n/zh-CN";
import { zhTW } from "../src/i18n/zh-TW";
import { GOOD_MD, ORIGIN, resetDb, seedAndLogin, seedWithSkills } from "./helpers";

const fetchIn = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { headers, redirect: "manual" });

const htmlIn = async (path: string, headers: Record<string, string> = {}) => (await fetchIn(path, headers)).text();

const withLang = (cookie: string, locale: string) => `${cookie}; sg_lang=${locale}`;

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
    [{ Cookie: "sg_lang=ja", "Accept-Language": "zh-CN" }, "ja"],
    [{ Cookie: "sg_lang=zh-TW", "Accept-Language": "zh-CN" }, "zh-TW"],
    [{ Cookie: "sg_lang=klingon", "Accept-Language": "zh-CN" }, "zh-CN"],
  ])("answers %o in %s", async (headers, locale) => {
    const res = await fetchIn("/", headers);
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
    const res = await fetchIn("/.well-known/agent-skills/index.json", { "Accept-Language": "ja" });
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
    expect(formatStamp("en", at)).toBe("Sep 27, 2026, 14:05");
    expect(formatStamp("zh-CN", at)).toContain("14:05");
    expect(formatStamp("zh-TW", at)).toContain("14:05");
    expect(formatStamp("ja", at)).toContain("2026年9月27日");
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
