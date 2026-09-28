import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./auth";
import { API_PREFIX, csrfToken } from "./csrf";
import { detectLocale, localeOf, messages } from "./i18n";
import { languageRoutes } from "./routes/language";
import { projectsRoutes } from "./routes/projects";
import { publishRoutes } from "./routes/publish";
import { registryRoutes } from "./routes/registry";
import { skillsRoutes } from "./routes/skills";
import { usersRoutes } from "./routes/users";

const app = new Hono<AppEnv>();

const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
    c.res.headers.set("Content-Language", localeOf(c));
    c.res.headers.append("Vary", "Accept-Language, Cookie");
  }
});

app.use("*", detectLocale);
app.use("*", csrf());
app.use("*", csrfToken);

app.get("/healthz", (c) => c.text("ok"));
app.route("/", languageRoutes);
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
app.route("/", projectsRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled", err);
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.path.startsWith(API_PREFIX) || accepts.includes("application/json")) {
    return c.json({ error: "internal_error", message: "Internal server error" }, 500);
  }
  return c.html(`<h1>${messages(c).errors.internal}</h1>`, 500);
});

export default app;
