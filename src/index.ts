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

const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
  }
});

app.use("*", csrf());
app.use("*", csrfToken);

app.get("/healthz", (c) => c.text("ok"));
app.route("/", registryRoutes);
app.route("/", usersRoutes);
app.route("/", publishRoutes);
app.route("/", skillsRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled", err);
  const accepts = c.req.header("Accept") ?? "";
  if (c.req.path.startsWith(API_PREFIX) || accepts.includes("application/json")) {
    return c.json({ error: "internal_error", message: "Internal server error" }, 500);
  }
  return c.html("<h1>Internal server error</h1>", 500);
});

export default app;
