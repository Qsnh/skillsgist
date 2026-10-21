import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION_DAYS, retentionCutoff, retentionDays } from "../src/retention";
import { DAY_MS } from "../src/time";

describe("download log retention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps 90 days when the variable is unset", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(retentionDays({})).toBe(90);
  });

  it("reads a positive whole number, ignoring surrounding spaces and leading zeros", () => {
    expect(retentionDays({ DOWNLOAD_LOG_RETENTION_DAYS: "7" })).toBe(7);
    expect(retentionDays({ DOWNLOAD_LOG_RETENTION_DAYS: " 365 " })).toBe(365);
    expect(retentionDays({ DOWNLOAD_LOG_RETENTION_DAYS: "030" })).toBe(30);
  });

  it.each(["", "0", "-3", "1.5", "abc", "7d", "1e3", "1234567"])("falls back to 90 days for %j and logs an error", (value) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(retentionDays({ DOWNLOAD_LOG_RETENTION_DAYS: value })).toBe(90);
    expect(error).toHaveBeenCalledOnce();
  });

  it("logs a value it cannot use once, not on every read", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) expect(retentionDays({ DOWNLOAD_LOG_RETENTION_DAYS: "90d" })).toBe(90);
    expect(error).toHaveBeenCalledOnce();
    expect(retentionDays({ DOWNLOAD_LOG_RETENTION_DAYS: "60d" })).toBe(90);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("puts the cutoff that many whole days before now", () => {
    expect(retentionCutoff(7, 10 * DAY_MS)).toBe(3 * DAY_MS);
  });
});
