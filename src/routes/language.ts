import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { cookieOptions } from "../auth";
import type { AppEnv } from "../auth";
import { isLocale, LOCALE_COOKIE } from "../i18n/locales";
import { safeNext } from "../paths";

const ONE_YEAR = 365 * 24 * 60 * 60;

export const languageRoutes = new Hono<AppEnv>();

languageRoutes.post("/lang", async (c) => {
  const body = await c.req.parseBody();
  if (isLocale(body.lang)) setCookie(c, LOCALE_COOKIE, body.lang, cookieOptions(c, ONE_YEAR));
  return c.redirect(safeNext(body.next), 302);
});
