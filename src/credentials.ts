import { randomHex } from "./auth";

export const INSTALL_KEY_PREFIX = "sgi_";
export const DEVICE_TOKEN_PREFIX = "sgd_";

export const newInstallKey = () => `${INSTALL_KEY_PREFIX}${randomHex(32)}`;

export const DEVICE_CODE_TTL_S = 600;
export const POLL_INTERVAL_S = 5;
export const SLOW_DOWN_S = 5;
export const LOGIN_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const LAST_USED_WRITE_MS = 60 * 60 * 1000;
export const CODE_ATTEMPT_LIMIT = 5;
export const CODE_LOCK_MS = 10 * 60 * 1000;
export const MAX_SCOPE_PROJECTS = 50;
export const DEVICE_NAME_MAX = 64;

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

export const newDeviceToken = () => `${DEVICE_TOKEN_PREFIX}${randomHex(32)}`;

export const newDeviceCode = () => randomHex(32);

export function newUserCode(): string {
  const letters: string[] = [];
  while (letters.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && letters.length < 8) letters.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
    }
  }
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const letters = value.toUpperCase().replace(/[\s-]/g, "");
  return USER_CODE.test(letters) ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
}
