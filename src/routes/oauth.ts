import { Hono } from "hono";
import type { AppEnv, Ctx } from "../auth";
import { randomHex } from "../auth";
import { bearerAccess, invalidToken, PRIVATE_HEADERS } from "../bearer";
import {
  DEVICE_CODE_TTL_S, DEVICE_NAME_MAX, DEVICE_TOKEN_PREFIX, MAX_SCOPE_PROJECTS, newDeviceCode, newDeviceToken, newUserCode,
  POLL_INTERVAL_S, SLOW_DOWN_S,
} from "../credentials";
import {
  activateLogin, createPendingLogin, deleteLogin, deleteLoginByTokenHash, deleteStaleLogins, getLoginByDeviceCodeHash,
  loginProjects, recordPoll,
} from "../db/logins";
import { sha256Hex } from "../hash";
import { PROJECT_SLUG } from "../paths";

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

export const CLIENT_ID = "skillsgist-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const NO_STORE = { "Cache-Control": "no-store" };
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

const oauthError = (error: string, status: 400 | 401 = 400) => Response.json({ error }, { status, headers: NO_STORE });

async function formFields(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function deviceName(value: string | undefined): string {
  return [...(value ?? "").replace(UNPRINTABLE, "").trim()].slice(0, DEVICE_NAME_MAX).join("");
}

function requestedScope(value: string | undefined): string | null {
  const projects = new Set<string>();
  for (const item of (value ?? "").split(/\s+/)) {
    if (projects.size === MAX_SCOPE_PROJECTS) break;
    const slug = item.startsWith("project:") ? item.slice("project:".length) : "";
    if (PROJECT_SLUG.test(slug)) projects.add(slug);
  }
  return projects.size > 0 ? [...projects].join(" ") : null;
}

function countryOf(c: Ctx): string | null {
  const country = c.req.raw.cf?.country;
  return typeof country === "string" ? country : null;
}

oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  const origin = new URL(c.req.url).origin;
  return Response.json({
    issuer: origin,
    device_authorization_endpoint: `${origin}/api/oauth/device`,
    token_endpoint: `${origin}/api/oauth/token`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    grant_types_supported: [DEVICE_GRANT],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

oauthRoutes.post("/api/oauth/device", async (c) => {
  const body = await formFields(c);
  if (body.client_id !== CLIENT_ID) return oauthError("invalid_client", 401);
  const now = Date.now();
  await deleteStaleLogins(c.env.DB, now);
  const deviceCode = newDeviceCode();
  const deviceCodeHash = await sha256Hex(deviceCode);
  const origin = new URL(c.req.url).origin;
  for (let attempt = 0; attempt < 3; attempt++) {
    const userCode = newUserCode();
    const created = await createPendingLogin(c.env.DB, {
      id: randomHex(16),
      userCode,
      deviceCodeHash,
      deviceName: deviceName(body.device_name),
      country: countryOf(c),
      requestedScope: requestedScope(body.scope),
      now,
    });
    if (created) {
      return Response.json(
        {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${origin}/device`,
          verification_uri_complete: `${origin}/device?code=${userCode}`,
          expires_in: DEVICE_CODE_TTL_S,
          interval: POLL_INTERVAL_S,
        },
        { headers: NO_STORE },
      );
    }
  }
  throw new Error("could not allocate a unique user code");
});

oauthRoutes.post("/api/oauth/token", async (c) => {
  const body = await formFields(c);
  if (body.client_id !== CLIENT_ID) return oauthError("invalid_client", 401);
  if (body.grant_type !== DEVICE_GRANT) return oauthError("unsupported_grant_type");
  if (!body.device_code) return oauthError("invalid_request");
  const login = await getLoginByDeviceCodeHash(c.env.DB, await sha256Hex(body.device_code));
  if (!login) return oauthError("invalid_grant");
  const now = Date.now();
  if (login.status === "denied") {
    await deleteLogin(c.env.DB, login.id);
    return oauthError("access_denied");
  }
  if (login.expires_at <= now) {
    await deleteLogin(c.env.DB, login.id);
    return oauthError("expired_token");
  }
  if (login.last_polled_at !== null && now - login.last_polled_at < (login.poll_interval - 1) * 1000) {
    await recordPoll(c.env.DB, login.id, now, login.poll_interval + SLOW_DOWN_S);
    return oauthError("slow_down");
  }
  await recordPoll(c.env.DB, login.id, now, login.poll_interval);
  if (login.status !== "approved") return oauthError("authorization_pending");
  const token = newDeviceToken();
  if (!(await activateLogin(c.env.DB, login.id, await sha256Hex(token), now))) return oauthError("invalid_grant");
  const projects = await loginProjects(c.env.DB, login.id);
  return Response.json(
    { access_token: token, token_type: "Bearer", scope: projects.map((p) => `project:${p}`).join(" ") },
    { headers: NO_STORE },
  );
});

oauthRoutes.post("/api/oauth/revoke", async (c) => {
  const body = await formFields(c);
  if (body.token?.startsWith(DEVICE_TOKEN_PREFIX)) await deleteLoginByTokenHash(c.env.DB, await sha256Hex(body.token));
  return new Response(null, { status: 200, headers: NO_STORE });
});
