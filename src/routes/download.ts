import { zipAttachment } from "../artifact";
import type { Ctx } from "../auth";
import type { BearerAccess } from "../bearer";
import { ANONYMOUS_DOWNLOADER, recordDownload } from "../db/downloads";
import type { Downloader } from "../db/downloads";
import type { ArtifactRef, UserRow } from "../db/queries";
import { countryOf } from "../request";

export function sessionDownloader(user: Pick<UserRow, "id" | "username"> | null): Downloader {
  return user ? { source: "web", userId: user.id, username: user.username, deviceName: null } : ANONYMOUS_DOWNLOADER;
}

export function bearerDownloader(access: BearerAccess): Downloader {
  switch (access.kind) {
    case "login":
      return { source: "device", userId: access.userId, username: access.username, deviceName: access.deviceName };
    case "install_key":
      return { source: "install_key", userId: access.userId, username: access.username, deviceName: null };
    default:
      return ANONYMOUS_DOWNLOADER;
  }
}

export function serveDownload(
  c: Ctx,
  object: R2ObjectBody,
  artifact: ArtifactRef,
  cacheable: boolean,
  downloader: Downloader,
): Response {
  if (c.req.method === "GET") {
    c.executionCtx.waitUntil(
      recordDownload(c.env.DB, {
        skillId: artifact.skill_id,
        version: artifact.version,
        downloader,
        country: countryOf(c),
        at: Date.now(),
      }).catch((err) => console.error("download record write failed", err)),
    );
  }
  return zipAttachment(object, artifact.slug, cacheable);
}
