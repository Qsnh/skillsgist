import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./auth";
import { API_PREFIX, csrfOrigin, csrfToken } from "./csrf";
import { detectLocale, localeOf, messages } from "./i18n";
import { deviceRoutes } from "./routes/device";
import { downloadsRoutes } from "./routes/downloads";
import { languageRoutes } from "./routes/language";
import { oauthRoutes } from "./routes/oauth";
import { projectsRoutes } from "./routes/projects";
import { publishRoutes } from "./routes/publish";
import { registryRoutes } from "./routes/registry";
import { skillsRoutes } from "./routes/skills";
import { usersRoutes } from "./routes/users";

export const app = new Hono<AppEnv>();

export const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const MB = 1024 * 1024;
const FORM_OVERHEAD = MB;
const SMALL_BODY = 256 * 1024;

const UPLOAD_ROUTES = [
  /^\/new$/,
  /^\/p\/[^/]+\/s\/[^/]+\/(?:edit|upload)$/,
  new RegExp(`^${API_PREFIX}projects/[^/]+/skills/[^/]+$`),
];

const wantsJson = (path: string, accept: string) => path.startsWith(API_PREFIX) || accept.includes("application/json");

const staticFiles = serveStatic<AppEnv>({
  root: PUBLIC_DIR,
  onFound: (path, c) => {
    c.header("Cache-Control", path.includes("/fonts/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
  },
});

const limitBody: MiddlewareHandler<AppEnv> = (c, next) => {
  const upload = UPLOAD_ROUTES.some((route) => route.test(c.req.path));
  const limit = upload ? c.env.config.limits.uploadBytes : SMALL_BODY;
  return bodyLimit({
    maxSize: upload ? limit + FORM_OVERHEAD : limit,
    onError: (c) => {
      const t = messages(c).errors;
      const message = upload ? t.payloadTooLarge(Math.round(limit / MB)) : t.requestTooLarge;
      if (wantsJson(c.req.path, c.req.header("Accept") ?? "")) return c.json({ error: "payload_too_large", message }, 413);
      return c.text(message, 413);
    },
  })(c, next);
};

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
    c.res.headers.set("Content-Language", localeOf(c));
    c.res.headers.append("Vary", "Accept-Language, Cookie");
  }
});

app.on(["GET", "HEAD"], "*", staticFiles);
app.use("*", detectLocale);
app.use("*", limitBody);
app.use("*", csrfOrigin);
app.use("*", csrfToken);

app.get("/healthz", (c) => c.text("ok"));
app.route("/", languageRoutes);
app.route("/", registryRoutes);
app.route("/", oauthRoutes);
app.route("/", usersRoutes);
app.route("/", deviceRoutes);
app.route("/", publishRoutes);
app.route("/", projectsRoutes);
app.route("/", downloadsRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled", err);
  if (wantsJson(c.req.path, c.req.header("Accept") ?? "")) {
    return c.json({ error: "internal_error", message: "Internal server error" }, 500);
  }
  return c.html(`<h1>${messages(c).errors.internal}</h1>`, 500);
});
