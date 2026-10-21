import { zipAttachment } from "../artifact";
import type { Ctx } from "../auth";
import type { BearerAccess } from "../bearer";
import { ANONYMOUS_DOWNLOADER, recordDownload } from "../db/downloads";
import type { Downloader } from "../db/downloads";
import type { ArtifactRef, UserRow } from "../db/queries";
import { countryOf, ipOf, userAgentOf } from "../request";
import type { ObjectInfo } from "../storage";

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

export type Archive = ObjectInfo & { body: ReadableStream<Uint8Array> | null };

export async function openArchive(c: Ctx, key: string): Promise<Archive | null> {
  if (c.req.method !== "HEAD") return c.env.storage.get(key);
  const info = await c.env.storage.head(key);
  return info ? { ...info, body: null } : null;
}

export function serveDownload(
  c: Ctx,
  archive: Archive,
  artifact: ArtifactRef,
  cacheable: boolean,
  downloader: Downloader,
): Response {
  if (c.req.method === "GET") {
    try {
      recordDownload(c.env.db, {
        skillId: artifact.skill_id,
        version: artifact.version,
        downloader,
        country: countryOf(c),
        ip: ipOf(c),
        userAgent: userAgentOf(c),
        at: Date.now(),
      });
    } catch (err) {
      console.error("download record write failed", err);
    }
  }
  return zipAttachment(archive.body, archive.size, artifact.slug, cacheable);
}
