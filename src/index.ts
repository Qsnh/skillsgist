import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./auth";
import { API_PREFIX, csrfToken } from "./csrf";
import { publishRoutes } from "./routes/publish";
import { registryRoutes } from "./routes/registry";
import { skillsRoutes } from "./routes/skills";
import { usersRoutes } from "./routes/users";

const app = new Hono<AppEnv>();

// Final-review Fix 4a: the markdown sanitizer (src/render/markdown.ts)
// runs once at publish time and the result is stored, so a future
// sanitizer improvement never retroactively cleans HTML that's already in
// the database. A CSP costs nothing at request time and makes any
// residual or future bypass inert regardless. Every page here loads only
// same-origin `/app.css` and ships no inline or external script, so
// `'self'` is sufficient with no `unsafe-inline` carve-out needed.
//
// Regression 2 (scoped re-review): `img-src` needs its own directive.
// Without it, `img-src` falls back to `default-src 'self'`, but the
// sanitizer's URL-scheme allowlist deliberately preserves external
// `http`/`https` image sources (badges, screenshots are the normal case
// for skill docs) — a real browser would refuse to load them under
// same-origin-only `default-src`. `data:` is deliberately not added here:
// the sanitizer only ever lets `http`/`https`/`mailto` schemes through, so
// a `data:` image URL can never survive sanitization in the first place.
const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
  }
});

// CSRF layer 1: reject any state-changing request that a browser would only
// send cross-site. `hono/csrf` accepts `Sec-Fetch-Site: same-origin`, else a
// same-origin `Origin` header, and rejects when it has neither to go on.
//
// Sec-Fetch-Site is the sharper of the two signals: `Sec-` is a forbidden
// header prefix so page JS cannot set it, and unlike `Origin` it distinguishes
// same-origin from same-*site* — which is the gap SameSite=Lax leaves open,
// since Lax is scoped to the registrable domain and treats every sibling
// subdomain as same-site.
//
// It only applies to content-types a form element can actually submit
// (urlencoded, multipart, text/plain), defaulting to text/plain when the
// header is absent so a header-less POST is still checked. Anything else is
// left alone, which is what lets `PUT /api/skills/:slug` keep publishing
// `application/zip` bodies with no Origin header: a cross-site request with a
// non-form content-type needs a CORS preflight, and nothing here serves CORS
// headers, so the preflight cannot succeed.
//
// The default origin comparison is against `new URL(c.req.url).origin`, which
// on Workers is the real client-facing URL. Behind a proxy that rewrites
// scheme or Host this would need `options.origin`.
app.use("*", csrf());

// CSRF layer 2: the session-bound token. See src/csrf.tsx.
app.use("*", csrfToken);

app.get("/healthz", (c) => c.text("ok"));
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  // Hono's *default* error handler is what renders an HTTPException using the
  // response the exception carries. Registering onError replaces that default
  // outright, so without this branch every HTTPException raised anywhere in
  // Hono — including the 403 from the `csrf()` middleware above — would be
  // logged as unhandled and answered with a misleading 500.
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled", err);
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.path.startsWith(API_PREFIX) || accepts.includes("application/json")) {
    return c.json({ error: "internal_error", message: "服务内部错误" }, 500);
  }
  return c.html("<h1>服务内部错误</h1>", 500);
});

export default app;
