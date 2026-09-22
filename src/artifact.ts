// The artifact wire contract, in one place: the download URL the discovery
// index advertises, the matcher the download route uses to read it back, and
// the response both download routes return. Emitter and matcher live next to
// each other so they can't drift apart.

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

export function zipAttachment(object: R2ObjectBody, slug: string, cacheable: boolean): Response {
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      // A private artifact must never land in a shared cache, and the two
      // download routes must agree about that — hence one spelling here.
      "Cache-Control": cacheable ? "public, max-age=300" : "private, no-store",
    },
  });
}
