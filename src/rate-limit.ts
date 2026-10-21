import { isIPv6 } from "node:net";

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweptAt = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  wait(key: string, now: number = Date.now()): number {
    this.sweep(now);
    const recent = this.recent(key, now);
    return recent.length >= this.limit ? recent[0] + this.windowMs - now : 0;
  }

  hit(key: string, now: number = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  take(key: string, now: number = Date.now()): number {
    const wait = this.wait(key, now);
    if (wait === 0) this.hit(key, now);
    return wait;
  }

  private recent(key: string, now: number): number[] {
    const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length > 0) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }

  private sweep(now: number): void {
    if (now - this.sweptAt < this.windowMs) return;
    this.sweptAt = now;
    for (const [key, times] of this.hits) {
      if (times[times.length - 1] <= now - this.windowMs) this.hits.delete(key);
    }
  }
}

export interface RateLimiters {
  deviceAuthorization: RateLimiter;
  signIn: RateLimiter;
}

export function createRateLimiters(): RateLimiters {
  return {
    deviceAuthorization: new RateLimiter(5, 10_000),
    signIn: new RateLimiter(10, 60_000),
  };
}

function ipv6Groups(ip: string): string[] {
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const missing = ip.includes("::") ? 8 - left.length - right.length : 0;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) => group.replace(/^0+(?=.)/, ""));
}

export function clientKey(ip: string | null): string {
  if (ip === null) return "";
  return isIPv6(ip) ? `${ipv6Groups(ip).slice(0, 4).join(":")}::/64` : ip;
}

export const retryAfterSeconds = (waitMs: number) => String(Math.max(1, Math.ceil(waitMs / 1000)));
