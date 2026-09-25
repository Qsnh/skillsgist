import { zipAttachment } from "../artifact";
import type { Ctx } from "../auth";
import { incrementDownloads } from "../db/queries";

export function serveDownload(c: Ctx, object: R2ObjectBody, slug: string, cacheable: boolean): Response {
  if (c.req.method === "GET") {
    c.executionCtx.waitUntil(
      incrementDownloads(c.env.DB, slug).catch((err) => console.error("download count write failed", err)),
    );
  }
  return zipAttachment(object, slug, cacheable);
}
