import { INTL_LOCALES } from "./locales";
import type { Locale } from "./locales";

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };

const STAMP: Intl.DateTimeFormatOptions = { ...DATE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

const dates = new Map<Locale, Intl.DateTimeFormat>();
const stamps = new Map<Locale, Intl.DateTimeFormat>();
const counts = new Map<Locale, Intl.NumberFormat>();
const lists = new Map<Locale, Intl.ListFormat>();

function cached<T>(cache: Map<Locale, T>, locale: Locale, make: (tag: string) => T): T {
  let value = cache.get(locale);
  if (!value) {
    value = make(INTL_LOCALES[locale]);
    cache.set(locale, value);
  }
  return value;
}

export const formatDate = (locale: Locale, ms: number): string =>
  cached(dates, locale, (tag) => new Intl.DateTimeFormat(tag, DATE)).format(ms);

export const formatStamp = (locale: Locale, ms: number): string =>
  cached(stamps, locale, (tag) => new Intl.DateTimeFormat(tag, STAMP)).format(ms);

export const formatCount = (locale: Locale, n: number): string =>
  cached(counts, locale, (tag) => new Intl.NumberFormat(tag)).format(n);

export const formatList = (locale: Locale, items: string[]): string =>
  cached(lists, locale, (tag) => new Intl.ListFormat(tag, { type: "conjunction" })).format(items);
