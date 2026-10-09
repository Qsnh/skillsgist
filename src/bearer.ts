import { bearerToken } from "./auth";
import type { Ctx } from "./auth";
import { DEVICE_TOKEN_PREFIX, INSTALL_KEY_PREFIX, LAST_USED_WRITE_MS, loginExpired } from "./credentials";
import { loginAccessByTokenHash, markLoginUsed } from "./db/logins";
import { getInstallKeyAccess, getMember } from "./db/queries";
import { sha256Hex } from "./hash";

export type BearerAccess =
  | { kind: "anonymous" }
  | { kind: "invalid" }
  | { kind: "login"; userId: string; username: string; projects: string[] }
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
  const token = bearerToken(c);
  if (token === null) return ANONYMOUS;
  if (!token) return INVALID;
  if (token.startsWith(INSTALL_KEY_PREFIX)) {
    const key = await getInstallKeyAccess(c.env.DB, token);
    return key ? { kind: "install_key", username: key.username, project: key.project } : INVALID;
  }
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return INVALID;
  const login = await loginAccessByTokenHash(c.env.DB, await sha256Hex(token));
  const now = Date.now();
  if (!login || loginExpired(login.last_used_at, now)) return INVALID;
  if (now - (login.last_used_at ?? 0) >= LAST_USED_WRITE_MS) {
    c.executionCtx.waitUntil(
      markLoginUsed(c.env.DB, login.id, now).catch((err) => console.error("cli login use write failed", err)),
    );
  }
  return { kind: "login", userId: login.user_id, username: login.username, projects: login.granted };
}

export async function projectGate(c: Ctx, project: string): Promise<ProjectGate> {
  const access = await bearerAccess(c);
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
      return {
        kind: "public",
        refusal: (await getMember(c.env.DB, project, access.userId)) ? forbidden("project_not_granted", project) : null,
      };
  }
}

export const unavailable = (gate: ProjectGate): Response =>
  (gate.kind === "public" && gate.refusal) || privateNotFound();
