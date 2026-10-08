import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { bearerAccess, invalidToken, PRIVATE_HEADERS } from "../bearer";

export const oauthRoutes = new Hono<AppEnv>();

oauthRoutes.get("/api/whoami", async (c) => {
  const access = await bearerAccess(c);
  if (access.kind === "anonymous") {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { ...PRIVATE_HEADERS, "WWW-Authenticate": "Bearer" } });
  }
  if (access.kind === "invalid") return invalidToken();
  const body =
    access.kind === "login"
      ? { user: access.username, kind: "login", projects: access.projects }
      : { user: access.username, kind: "install_key", projects: [access.project] };
  return Response.json(body, { headers: PRIVATE_HEADERS });
});
