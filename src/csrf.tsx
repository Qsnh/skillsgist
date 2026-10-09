import { createContext, useContext } from "hono/jsx";
import type { MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import type { JSX } from "hono/jsx/jsx-runtime";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { constantTimeEqual, CSRF_FIELD, sessionCsrf } from "./auth";
import type { AppEnv, Ctx } from "./auth";
import { FlashContext, takeFlash } from "./flash";
import { LocaleContext, localeOf, messages } from "./i18n";
import { safeNext } from "./paths";


const CsrfContext = createContext<string>("");

export const OriginContext = createContext<string>("");

export const ReturnPathContext = createContext<string>("/");

export function OptionalCsrfField() {
  const token = useContext(CsrfContext);
  return token ? <input type="hidden" name={CSRF_FIELD} value={token} /> : null;
}

export function CsrfField() {
  const token = useContext(CsrfContext);
  if (!token) {
    throw new Error("CsrfField rendered outside page() — no CSRF token in context");
  }
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

export function Form(props: {
  action: string;
  class?: string;
  enctype?: "multipart/form-data";
  children?: unknown;
}) {
  return (
    <form method="post" action={props.action} class={props.class} enctype={props.enctype}>
      <CsrfField />
      {props.children}
    </form>
  );
}

export async function page(
  c: Ctx,
  element: JSX.Element,
  status?: ContentfulStatusCode,
  returnTo?: string,
): Promise<Response> {
  const [token, flashed] = await Promise.all([sessionCsrf(c), takeFlash(c)]);
  const here = new URL(c.req.url);
  return c.html(
    <LocaleContext.Provider value={localeOf(c)}>
      <ReturnPathContext.Provider value={returnTo ?? safeNext(`${here.pathname}${here.search}`)}>
        <OriginContext.Provider value={here.origin}>
          <CsrfContext.Provider value={token ?? ""}>
            <FlashContext.Provider value={flashed}>{element}</FlashContext.Provider>
          </CsrfContext.Provider>
        </OriginContext.Provider>
      </ReturnPathContext.Provider>
    </LocaleContext.Provider>,
    status,
  );
}

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);


export const API_PREFIX = "/api/";

const OAUTH_PREFIX = "/api/oauth/";

const TOKENLESS_PATHS = new Set(["/setup", "/login"]);

const sameOrigin = csrf();

export const csrfOrigin: MiddlewareHandler<AppEnv> = (c, next) =>
  c.req.path.startsWith(OAUTH_PREFIX) ? next() : sameOrigin(c, next);

export const csrfToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (c.req.path.startsWith(API_PREFIX)) return next();
  if (TOKENLESS_PATHS.has(c.req.path)) return next();

  const expected = await sessionCsrf(c);
  if (expected === null) return next();

  const body = await c.req.parseBody();
  const supplied = body[CSRF_FIELD];
  if (typeof supplied !== "string" || !constantTimeEqual(supplied, expected)) {
    return c.text(messages(c).errors.requestValidation, 403);
  }
  return next();
};
