import { Hono } from "hono";
import { usersRoutes } from "./routes/users";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));
app.route("/", usersRoutes);

export default app;
