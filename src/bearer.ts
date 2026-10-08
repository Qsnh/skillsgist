import type { Ctx } from "./auth";
import { DEVICE_TOKEN_PREFIX, INSTALL_KEY_PREFIX, LAST_USED_WRITE_MS, LOGIN_IDLE_MS } from "./credentials";
import { loginAccessByTokenHash, markLoginUsed } from "./db/logins";
import { getInstallKeyAccess } from "./db/queries";
import { sha256Hex } from "./hash";

export type BearerAccess =
  | { kind: "anonymous" }
  | { kind: "invalid" }
  | { kind: "login"; loginId: string; username: string; projects: string[]; memberOf: string[] }
  | { kind: "install_key"; username: string; project: string };

export type ProjectGate = { kind: "all" } | { kind: "public"; refusal: Response | null };

export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };

const ANONYMOUS: BearerAccess = { kind: "anonymous" };
const INVALID: BearerAccess = { kind: "invalid" };

export function invalidToken(): Response {
  return Response.json(
    { error: "invalid_token" },
    { status: 401, headers: { ...PRIVATE_HEADERS, "WWW-Authenticate": 'Bearer error="invalid_token"' } },
  );
}

export function privateNotFound(): Response {
  return new Response("not found", { status: 404, headers: PRIVATE_HEADERS });
}

function forbidden(error: "wrong_project" | "project_not_granted", project: string): Response {
  return Response.json({ error, project }, { status: 403, headers: PRIVATE_HEADERS });
}

export async function bearerAccess(c: Ctx): Promise<BearerAccess> {
  const header = c.req.header("Authorization")?.trim();
  if (!header) return ANONYMOUS;
  const [scheme, token, ...rest] = header.split(/\s+/);
  if (scheme.toLowerCase() !== "bearer") return ANONYMOUS;
  if (!token || rest.length > 0) return INVALID;
  if (token.startsWith(INSTALL_KEY_PREFIX)) {
    const key = await getInstallKeyAccess(c.env.DB, token);
    return key ? { kind: "install_key", username: key.username, project: key.project } : INVALID;
  }
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return INVALID;
  const login = await loginAccessByTokenHash(c.env.DB, await sha256Hex(token));
  const now = Date.now();
  if (!login || login.last_used_at === null || login.last_used_at <= now - LOGIN_IDLE_MS) return INVALID;
  if (now - login.last_used_at >= LAST_USED_WRITE_MS) {
    c.executionCtx.waitUntil(
      markLoginUsed(c.env.DB, login.id, now).catch((err) => console.error("cli login use write failed", err)),
    );
  }
  return { kind: "login", loginId: login.id, username: login.username, projects: login.granted, memberOf: login.memberOf };
}

export function projectGate(access: BearerAccess, project: string): ProjectGate {
  switch (access.kind) {
    case "anonymous":
      return { kind: "public", refusal: null };
    case "invalid":
      return { kind: "public", refusal: invalidToken() };
    case "install_key":
      return access.project === project
        ? { kind: "all" }
        : { kind: "public", refusal: forbidden("wrong_project", access.project) };
    case "login":
      if (access.projects.includes(project)) return { kind: "all" };
      return { kind: "public", refusal: access.memberOf.includes(project) ? forbidden("project_not_granted", project) : null };
  }
}

export const unavailable = (gate: ProjectGate): Response =>
  (gate.kind === "public" && gate.refusal) || privateNotFound();
