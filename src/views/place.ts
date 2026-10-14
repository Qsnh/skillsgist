import type { Messages } from "../i18n/en";
import { formatRegion } from "../i18n/format";
import type { Locale } from "../i18n/locales";

export function requestPlace(t: Messages, locale: Locale, country: string | null): string {
  if (country === "T1") return t.device.tor;
  if (!country || country === "XX") return t.device.unknownPlace;
  return formatRegion(locale, country) ?? country;
}
