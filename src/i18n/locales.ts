export const LOCALES = ["en", "zh-CN", "zh-TW", "ja"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "sg_lang";

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文", "zh-TW": "繁體中文", ja: "日本語" };

export const INTL_LOCALES: Record<Locale, string> = { en: "en-US", "zh-CN": "zh-CN", "zh-TW": "zh-TW", ja: "ja-JP" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
