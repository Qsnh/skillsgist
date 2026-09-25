import type { Ctx } from "./auth";
import { incrementDownloads } from "./db/queries";

export const DIGEST_PREFIX = "sha256:";

const ARTIFACT_FILE_RE = /^([a-f0-9]{64})\.zip$/;

/** `<baseUrl>/d/<slug>/<hex>.zip` — `baseUrl` is an origin, optionally `/i/<key>`. */
export function artifactUrl(baseUrl: string, slug: string, digest: string): string {
  return `${baseUrl}/d/${slug}/${digest.slice(DIGEST_PREFIX.length)}.zip`;
}

/** The `<hex>.zip` filename back to a full `sha256:<hex>` digest, or null. */
export function digestFromArtifactFile(file: string): string | null {
  const match = ARTIFACT_FILE_RE.exec(file);
  return match ? `${DIGEST_PREFIX}${match[1]}` : null;
}

export function serveDownload(c: Ctx, object: R2ObjectBody, slug: string, cacheable: boolean): Response {
  if (c.req.method === "GET") {
    c.executionCtx.waitUntil(
      incrementDownloads(c.env.DB, slug).catch((err) => console.error("download count write failed", err)),
    );
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Cache-Control": cacheable ? "public, max-age=300" : "private, no-store",
    },
  });
}
