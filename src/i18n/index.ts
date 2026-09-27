import { createContext, useContext } from "hono/jsx";
import { languageDetector } from "hono/language";
import type { Ctx } from "../auth";
import { en } from "./en";
import type { Messages } from "./en";
import { ja } from "./ja";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, LOCALES } from "./locales";
import type { Locale } from "./locales";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

export const CATALOGS: Record<Locale, Messages> = { en, "zh-CN": zhCN, "zh-TW": zhTW, ja };

const TRADITIONAL = /^zh-(hant|tw|hk|mo)(-|$)/i;

const CHINESE = /^zh(-|$)/i;

export const detectLocale = languageDetector({
  supportedLanguages: [...LOCALES],
  fallbackLanguage: DEFAULT_LOCALE,
  order: ["cookie", "header"],
  lookupCookie: LOCALE_COOKIE,
  caches: false,
  convertDetectedLanguage: (lang) => (TRADITIONAL.test(lang) ? "zh-TW" : CHINESE.test(lang) ? "zh-CN" : lang),
});

export function localeOf(c: Ctx): Locale {
  const detected = c.get("language");
  return isLocale(detected) ? detected : DEFAULT_LOCALE;
}

export const messages = (c: Ctx): Messages => CATALOGS[localeOf(c)];

export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export const useLocale = (): Locale => useContext(LocaleContext);

export const useT = (): Messages => CATALOGS[useLocale()];
