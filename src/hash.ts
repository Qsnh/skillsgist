/** Bytes → lowercase hex. The one place that spelling lives. */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
