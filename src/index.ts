import { Hono } from "hono";
import { publishRoutes } from "./routes/publish";
import { registryRoutes } from "./routes/registry";
import { skillsRoutes } from "./routes/skills";
import { usersRoutes } from "./routes/users";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

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

app.get("/healthz", (c) => c.text("ok"));
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  console.error("unhandled", err);
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.path.startsWith("/api/") || accepts.includes("application/json")) {
    return c.json({ error: "internal_error", message: "服务内部错误" }, 500);
  }
  return c.html("<h1>服务内部错误</h1>", 500);
});

export default app;
