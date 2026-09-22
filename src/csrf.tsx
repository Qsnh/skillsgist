import { createContext, useContext } from "hono/jsx";
import type { MiddlewareHandler } from "hono";
// `JSX.Element` lives in the jsx-runtime module (the tsconfig jsxImportSource),
// not in "hono/jsx" — that one re-exports a narrower JSX namespace for
// intrinsic elements which has no `Element` member.
import type { JSX } from "hono/jsx/jsx-runtime";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { constantTimeEqual, CSRF_FIELD, sessionCsrf } from "./auth";
import type { AppEnv, Ctx } from "./auth";

// All of CSRF protection: the token, the middleware that checks it, and the
// <Form> component that is the only way to emit a mutating form.
//
// Two independent layers, both unconditional middleware in src/index.ts.
// Default-on is the point — opting *out* takes an explicit, tested list entry.
//   Layer 1  `hono/csrf` (Origin + Sec-Fetch-Site).
//   Layer 2  `csrfToken` below: a random token inside the signed session
//            cookie, rendered into every mutating form, compared on the way in.
//
// The token lives in the session rather than a second cookie because the usual
// double-submit pattern fails against a sibling subdomain: `SameSite=Lax` is
// scoped to the registrable domain, so an attacker on `evil.example.com` can
// set a `Domain=.example.com` CSRF cookie of their choosing, echo it in a
// forged form, and pass the comparison. Signing it doesn't help — that proves
// the server minted the value, not that it belongs to the victim's session.
// Binding into the signed session does: passing now requires SESSION_SECRET,
// and injecting your own session just runs the request as your own account.

const CsrfContext = createContext<string>("");

/**
 * The hidden field carrying the session's CSRF token.
 *
 * Throws when rendered outside `page()`: `hono/jsx` falls back to the
 * context's default when no Provider is in scope, so a page rendered through
 * a bare `c.html` would otherwise emit an empty token and fail later as a
 * puzzling 403 on submit. A 500 on the GET is caught by any existing test.
 */
export function CsrfField() {
  const token = useContext(CsrfContext);
  if (!token) {
    throw new Error("CsrfField rendered outside page() — no CSRF token in context");
  }
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

/**
 * A POST form. The only supported way to write one: it is what guarantees the
 * token is present, so `<form method="post">` should not appear in views.
 * test/csrf.test.ts asserts that by walking the rendered HTML of every page.
 *
 * GET forms (the search box) stay plain `<form method="get">` — a token in a
 * GET form would leak into the URL and from there into Referer headers.
 */
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

/** Replaces `c.html` for every JSX response, putting the token in scope. */
export async function page(
  c: Ctx,
  element: JSX.Element,
  status?: ContentfulStatusCode,
): Promise<Response> {
  const token = (await sessionCsrf(c)) ?? "";
  return c.html(<CsrfContext.Provider value={token}>{element}</CsrfContext.Provider>, status);
}

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Prefix of the token-authenticated JSON API. One constant, because three
 * places must agree: the exemption below, the JSON error shape in
 * src/index.ts, and the route registration in routes/publish.tsx.
 */
export const API_PREFIX = "/api/";

// Mutating routes with no session yet, so no session-bound token to carry.
// Layer 1 still covers both. Closing login CSRF properly would need a
// pre-session cookie from `GET /login`; the payoff is small (the attacker
// needs valid credentials of their own, and wins only a victim publishing
// into the attacker's account), so it is a deliberate trade-off.
const TOKENLESS_PATHS = new Set(["/setup", "/login"]);

export const csrfToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  // `/api/*` authenticates by `Authorization: Bearer` and never reads the
  // session cookie, and browsers don't attach that header on their own — so
  // it is structurally unreachable by CSRF. test/csrf.test.ts pins the
  // invariant this rests on: a session cookie alone cannot authenticate
  // against `/api/*`. Matching on path rather than content-type is
  // deliberate — a content-type rule would silently extend this exemption to
  // a future cookie-authenticated JSON endpoint.
  if (c.req.path.startsWith(API_PREFIX)) return next();
  if (TOKENLESS_PATHS.has(c.req.path)) return next();

  const expected = await sessionCsrf(c);
  // No session: nothing to protect, and no token to check against. Every
  // mutating route below resolves `currentUser()` first and redirects to
  // /login when it is null, so letting the request through changes nothing.
  if (expected === null) return next();

  // Safe to parse here: Hono memoises `req.arrayBuffer()` and caches the
  // FormData on `req.bodyCache`, so the route's own `parseBody()` gets the
  // cached result rather than a consumed stream. A non-form content-type
  // returns `{}` without touching the body at all.
  const body = await c.req.parseBody();
  const supplied = body[CSRF_FIELD];
  if (typeof supplied !== "string" || !constantTimeEqual(supplied, expected)) {
    return c.text("请求校验失败，请刷新页面后重试", 403);
  }
  return next();
};
