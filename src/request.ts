import type { Ctx } from "./auth";

const MAX_USER_AGENT = 512;

export function countryOf(c: Ctx): string | null {
  const country = c.req.raw.cf?.country;
  return typeof country === "string" ? country : null;
}

export const ipOf = (c: Ctx): string | null => c.req.header("CF-Connecting-IP") || null;

export const userAgentOf = (c: Ctx): string | null => c.req.header("User-Agent")?.slice(0, MAX_USER_AGENT) || null;
