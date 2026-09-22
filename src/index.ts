import { Hono } from "hono";
import { publishRoutes } from "./routes/publish";
import { registryRoutes } from "./routes/registry";
import { skillsRoutes } from "./routes/skills";
import { usersRoutes } from "./routes/users";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

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
