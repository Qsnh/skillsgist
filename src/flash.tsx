import { deleteCookie, getCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createContext } from "hono/jsx";
import { constantTimeEqual, cookieOptions, sessionCsrf } from "./auth";
import type { Ctx } from "./auth";

export const FLASH_COOKIE = "sg_flash";

export const FlashContext = createContext<string | undefined>(undefined);

export async function flash(c: Ctx, message: string): Promise<void> {
  const csrf = await sessionCsrf(c);
  if (!csrf) return;
  await setSignedCookie(c, FLASH_COOKIE, `${csrf}:${message}`, c.env.SESSION_SECRET, cookieOptions(c, 60));
}

export async function takeFlash(c: Ctx): Promise<string | undefined> {
  if (getCookie(c, FLASH_COOKIE) === undefined) return undefined;
  const [value, csrf] = await Promise.all([
    getSignedCookie(c, c.env.SESSION_SECRET, FLASH_COOKIE),
    sessionCsrf(c),
  ]);
  deleteCookie(c, FLASH_COOKIE, { path: "/" });
  if (!value || !csrf) return undefined;
  const split = value.indexOf(":");
  if (split < 0 || !constantTimeEqual(value.slice(0, split), csrf)) return undefined;
  return value.slice(split + 1) || undefined;
}
