import { createContext, useContext } from "hono/jsx";
import type { MiddlewareHandler } from "hono";
// `JSX.Element` lives in the jsx-runtime module (the tsconfig jsxImportSource),
// not in "hono/jsx" — that one re-exports a narrower JSX namespace for
// intrinsic elements which has no `Element` member.
import type { JSX } from "hono/jsx/jsx-runtime";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { constantTimeEqual, CSRF_FIELD, sessionCsrf } from "./auth";
import type { AppEnv, Ctx } from "./auth";

// Everything that implements CSRF protection lives in this one file: the token
// itself, the middleware that checks it, and the <Form> component that is the
// only way to emit a mutating form. One file to read to understand the whole
// mechanism.
//
// There are two independent layers, both registered as unconditional
// middleware in src/index.ts. Default-on matters more than either layer's
// details: the bug this code fixes was that protection had to be remembered
// per route, and it wasn't. Opting *out* is now the thing that takes an
// explicit, tested entry in a list.
//
// Layer 1 is `hono/csrf` (Origin + Sec-Fetch-Site), wired up in src/index.ts.
//
// Layer 2 is `csrfToken` below: a random token stored inside the existing
// signed session cookie, rendered into every mutating form, and compared on
// the way back in.
//
// Why the token lives in the session rather than in a second cookie: the
// usual double-submit pattern (token in its own cookie, compared against the
// same value in the form) fails against a sibling subdomain. `SameSite=Lax`
// is scoped to the registrable domain, so anything on `*.example.com` counts
// as same-site; an attacker holding `evil.example.com` can set a
// `Domain=.example.com` CSRF cookie whose value they chose, echo that value
// in their forged form, and the comparison passes. Signing the cookie does
// not help — a signature proves the server minted the value, not that the
// value belongs to the victim's session.
//
// Binding the token into the signed session closes that off. Passing the
// check requires a validly signed session carrying a chosen `csrf`, which
// requires SESSION_SECRET; and injecting your own real session just makes the
// request run as your account, which harms nobody.

const CsrfContext = createContext<string>("");

/**
 * The hidden field carrying the session's CSRF token.
 *
 * Throws when rendered outside `page()`. `hono/jsx` falls back to a context's
 * default value when no Provider is in scope, so without this guard a page
 * rendered through a bare `c.html` would emit an empty token and only fail
 * later, as a puzzling 403 on submit. Failing at render time turns that into
 * a 500 on the GET, which any existing test for the page will catch.
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

/**
 * Render an HTML page with the session's CSRF token in scope. Replaces
 * `c.html` for every JSX response.
 */
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
 * layers have to agree on it: this middleware's exemption below, the JSON
 * error shape in src/index.ts, and the route registration in
 * routes/publish.tsx. Versioning the API under a different prefix would
 * otherwise silently desynchronise them.
 */
export const API_PREFIX = "/api/";

// Mutating routes that cannot carry a session-bound token because no session
// exists yet. Layer 1 (Origin / Sec-Fetch-Site) still covers both.
//
// This is a deliberate trade-off, not an oversight. Protecting these against
// login CSRF properly needs a pre-session cookie issued by `GET /login`, and
// the payoff here is small: an attacker needs valid credentials of their own,
// and the win is tricking someone into publishing into the attacker's
// account. If that becomes worth closing, that is the upgrade path.
const TOKENLESS_PATHS = new Set(["/setup", "/login"]);

export const csrfToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  // `/api/*` authenticates by `Authorization: Bearer` and never reads the
  // session cookie (see routes/publish.tsx), and browsers do not attach an
  // Authorization header on their own — so it is structurally unreachable by
  // CSRF and could not carry a form token anyway. test/csrf.test.ts pins the
  // invariant this rests on: a session cookie alone cannot authenticate
  // against `/api/*`.
  //
  // Matching on the path rather than on the content-type (the way layer 1
  // does) is intentional. A content-type rule would make this exemption
  // implicit, and a future cookie-authenticated JSON endpoint would inherit
  // it silently.
  if (c.req.path.startsWith(API_PREFIX)) return next();
  if (TOKENLESS_PATHS.has(c.req.path)) return next();

  const expected = await sessionCsrf(c);
  // No session: nothing to protect, and no token to check against. Every
  // mutating route below resolves `currentUser()` first and redirects to
  // /login when it is null, so letting the request through changes nothing.
  if (expected === null) return next();

  // Safe to parse here: Hono caches the parsed body (`parseBody` reads through
  // `req.arrayBuffer()`, which is memoised, and stores the FormData on
  // `req.bodyCache`), so the route's own `parseBody()` call gets the cached
  // result instead of a consumed stream. A non-form content-type returns `{}`
  // without touching the body at all, which is why `PUT /api/*` reading
  // `arrayBuffer()` would still work even if it were not exempted above.
  const body = await c.req.parseBody();
  const supplied = body[CSRF_FIELD];
  if (typeof supplied !== "string" || !constantTimeEqual(supplied, expected)) {
    return c.text("请求校验失败，请刷新页面后重试", 403);
  }
  return next();
};
