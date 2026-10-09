import { INTL_LOCALES } from "./locales";
import type { Locale } from "./locales";

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };

const STAMP: Intl.DateTimeFormatOptions = { ...DATE, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" };

const dates = new Map<Locale, Intl.DateTimeFormat>();
const stamps = new Map<Locale, Intl.DateTimeFormat>();
const counts = new Map<Locale, Intl.NumberFormat>();
const lists = new Map<Locale, Intl.ListFormat>();
const regions = new Map<Locale, Intl.DisplayNames>();
const relatives = new Map<Locale, Intl.RelativeTimeFormat>();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AGO_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * DAY_MS],
  ["month", 30 * DAY_MS],
  ["day", DAY_MS],
  ["hour", HOUR_MS],
];

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

export function formatAgo(locale: Locale, ms: number, now: number): string | null {
  const elapsed = now - ms;
  const step = AGO_UNITS.find(([, size]) => elapsed >= size);
  if (!step) return null;
  const [unit, size] = step;
  return cached(relatives, locale, (tag) => new Intl.RelativeTimeFormat(tag)).format(-Math.floor(elapsed / size), unit);
}

export function formatRegion(locale: Locale, code: string): string | undefined {
  try {
    return cached(regions, locale, (tag) => new Intl.DisplayNames(tag, { type: "region", fallback: "none" })).of(code);
  } catch {
    return undefined;
  }
}
