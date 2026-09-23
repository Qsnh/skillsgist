import { createContext, useContext } from "hono/jsx";
import type { MiddlewareHandler } from "hono";
import type { JSX } from "hono/jsx/jsx-runtime";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { constantTimeEqual, CSRF_FIELD, sessionCsrf } from "./auth";
import type { AppEnv, Ctx } from "./auth";


const CsrfContext = createContext<string>("");

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
): Promise<Response> {
  const token = (await sessionCsrf(c)) ?? "";
  return c.html(<CsrfContext.Provider value={token}>{element}</CsrfContext.Provider>, status);
}

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);


export const API_PREFIX = "/api/";

const TOKENLESS_PATHS = new Set(["/setup", "/login"]);

export const csrfToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (c.req.path.startsWith(API_PREFIX)) return next();
  if (TOKENLESS_PATHS.has(c.req.path)) return next();

  const expected = await sessionCsrf(c);
  if (expected === null) return next();

  const body = await c.req.parseBody();
  const supplied = body[CSRF_FIELD];
  if (typeof supplied !== "string" || !constantTimeEqual(supplied, expected)) {
    return c.text("Request validation failed. Refresh the page and try again.", 403);
  }
  return next();
};
