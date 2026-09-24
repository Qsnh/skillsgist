import { deleteCookie, getCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createContext } from "hono/jsx";
import type { Ctx } from "./auth";

export const FLASH_COOKIE = "sg_flash";

export const FlashContext = createContext<string | undefined>(undefined);

export async function flash(c: Ctx, message: string): Promise<void> {
  await setSignedCookie(c, FLASH_COOKIE, message, c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 60,
  });
}

export async function takeFlash(c: Ctx): Promise<string | undefined> {
  if (getCookie(c, FLASH_COOKIE) === undefined) return undefined;
  const message = await getSignedCookie(c, c.env.SESSION_SECRET, FLASH_COOKIE);
  deleteCookie(c, FLASH_COOKIE, { path: "/" });
  return message || undefined;
}
