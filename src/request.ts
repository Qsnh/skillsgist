import type { Ctx } from "./auth";

export function countryOf(c: Ctx): string | null {
  const country = c.req.raw.cf?.country;
  return typeof country === "string" ? country : null;
}
