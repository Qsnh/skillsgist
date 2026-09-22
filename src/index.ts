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

// The sanitizer (src/render/markdown.ts) runs once at publish time and the
// result is stored, so a later sanitizer improvement never retroactively
// cleans HTML already in the database. A CSP costs nothing per request and
// makes any residual or future bypass inert regardless. Pages load only
// same-origin `/app.css` and ship no script, so `'self'` needs no
// `unsafe-inline` carve-out.
//
// `img-src` must be spelled out: falling back to `default-src 'self'` would
// break the external `http`/`https` images the sanitizer deliberately keeps
// (badges and screenshots are the normal case for skill docs). `data:` is
// deliberately absent — the sanitizer only passes `http`/`https`/`mailto`,
// so a `data:` image can never survive it in the first place.
const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
  }
});

// CSRF layer 1: reject any state-changing request a browser would only send
// cross-site. `hono/csrf` takes `Sec-Fetch-Site: same-origin`, else a
// same-origin `Origin`, and rejects with neither. Sec-Fetch-Site is the
// sharper signal — `Sec-` is a forbidden header prefix so page JS cannot set
// it, and it separates same-origin from same-*site*, which is exactly the gap
// SameSite=Lax leaves open across sibling subdomains.
//
// It only covers content-types a form can submit (urlencoded, multipart,
// text/plain), defaulting to text/plain so a header-less POST is still
// checked. Everything else is left alone — that is what lets
// `PUT /api/skills/:slug` publish `application/zip` with no Origin: a
// cross-site non-form content-type needs a CORS preflight, and nothing here
// serves CORS headers.
//
// The origin comparison is against `new URL(c.req.url).origin`, the real
// client-facing URL on Workers. Behind a proxy that rewrites scheme or Host
// this would need `options.origin`.
app.use("*", csrf());

// CSRF layer 2: the session-bound token. See src/csrf.tsx.
app.use("*", csrfToken);

app.get("/healthz", (c) => c.text("ok"));
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  // Registering onError replaces Hono's default handler outright, and that
  // default is what renders an HTTPException's own response. Without this
  // branch every HTTPException — including the 403 from `csrf()` above —
  // would be logged as unhandled and answered with a misleading 500.
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled", err);
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.path.startsWith(API_PREFIX) || accepts.includes("application/json")) {
    return c.json({ error: "internal_error", message: "服务内部错误" }, 500);
  }
  return c.html("<h1>服务内部错误</h1>", 500);
});

export default app;
