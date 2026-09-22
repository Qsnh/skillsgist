import { describe, expect, it } from "vitest";
import { isValidDescription, isValidSkillName, parseFrontmatter } from "../src/skills/frontmatter";

describe("parseFrontmatter", () => {
  it("extracts simple key/value pairs", () => {
    const { data, body } = parseFrontmatter("---\nname: demo\ndescription: hi\n---\n# Title\n");
    expect(data.name).toBe("demo");
    expect(data.description).toBe("hi");
    expect(body).toBe("# Title\n");
  });

  it("handles folded block scalars", () => {
    const src = "---\nname: demo\ndescription: >-\n  first line\n  second line\n---\nbody";
    const { data } = parseFrontmatter(src);
    expect(data.description).toBe("first line second line");
  });

  it("returns empty data when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter("# Just markdown");
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown");
  });

  it("tolerates CRLF line endings", () => {
    const { data } = parseFrontmatter("---\r\nname: demo\r\ndescription: hi\r\n---\r\nbody");
    expect(data.name).toBe("demo");
  });
});

describe("isValidSkillName", () => {
  it.each(["a", "demo", "my-skill", "a1-b2", "x".repeat(64)])("accepts %s", (name) => {
    expect(isValidSkillName(name)).toBe(true);
  });

  it.each([
    ["", "空字符串"],
    ["x".repeat(65), "超过 64 字符"],
    ["Demo", "含大写"],
    ["my_skill", "含下划线"],
    ["my skill", "含空格"],
    ["-demo", "以连字符开头"],
    ["demo-", "以连字符结尾"],
    ["my--skill", "含连续连字符"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidSkillName(name)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidSkillName(undefined)).toBe(false);
    expect(isValidSkillName(42)).toBe(false);
  });
});

describe("isValidDescription", () => {
  it("accepts a normal description", () => {
    expect(isValidDescription("Does a thing.")).toBe(true);
  });

  it("rejects empty and oversized values", () => {
    expect(isValidDescription("")).toBe(false);
    expect(isValidDescription("x".repeat(1025))).toBe(false);
    expect(isValidDescription("x".repeat(1024))).toBe(true);
  });
});
