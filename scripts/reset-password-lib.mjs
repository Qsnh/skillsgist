export const PBKDF2_ITERATIONS = 10_000;
export const MIN_PASSWORD_LENGTH = 12;
export const USERNAME = /^[a-z0-9-]{2,32}$/;

const base64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64(salt)}$${base64(bits)}`;
}

export function resetPasswordSql(username, passwordHash) {
  if (!USERNAME.test(username)) throw new Error(`"${username}" is not a valid username.`);
  if (!/^pbkdf2\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(passwordHash)) throw new Error("Invalid password hash.");
  return `UPDATE users SET password_hash = '${passwordHash}' WHERE username = '${username}' RETURNING username`;
}
