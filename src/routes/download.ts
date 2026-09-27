import { zipAttachment } from "../artifact";
import type { Ctx } from "../auth";
import { incrementDownloads } from "../db/queries";

export function serveDownload(
  c: Ctx,
  object: R2ObjectBody,
  skill: { project: string; slug: string },
  cacheable: boolean,
): Response {
  if (c.req.method === "GET") {
    c.executionCtx.waitUntil(
      incrementDownloads(c.env.DB, skill.project, skill.slug).catch((err) =>
        console.error("download count write failed", err),
      ),
    );
  }
  return zipAttachment(object, skill.slug, cacheable);
}
