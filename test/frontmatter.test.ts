import { describe, expect, it } from "vitest";
import { isValidDescription, isValidSkillName, parseFrontmatter } from "../src/skills/frontmatter";

describe("parseFrontmatter", () => {
  it.each([
    ["simple key/value pairs", "---\nname: demo\ndescription: hi\n---\n# Title\n", { name: "demo", description: "hi" }, "# Title\n"],
    ["folded block scalars", "---\nname: demo\ndescription: >-\n  first line\n  second line\n---\nbody", { name: "demo", description: "first line second line" }, "body"],
    ["CRLF line endings", "---\r\nname: demo\r\ndescription: hi\r\n---\r\nbody", { name: "demo", description: "hi" }, "body"],
    ["no frontmatter", "# Just markdown", {}, "# Just markdown"],
  ])("parses %s", (_label, src, data, body) => {
    expect(parseFrontmatter(src)).toEqual({ data, body });
  });
});

describe("isValidSkillName", () => {
  it.each(["a", "demo", "my-skill", "a1-b2", "x".repeat(64)])("accepts %s", (name) => {
    expect(isValidSkillName(name)).toBe(true);
  });

  it.each<[unknown, string]>([
    ["", "empty string"],
    ["x".repeat(65), "longer than 64 characters"],
    ["Demo", "contains uppercase"],
    ["my_skill", "contains an underscore"],
    ["my skill", "contains a space"],
    ["-demo", "starts with a hyphen"],
    ["demo-", "ends with a hyphen"],
    ["my--skill", "contains consecutive hyphens"],
    [undefined, "not a string"],
    [42, "not a string"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidSkillName(name)).toBe(false);
  });
});

describe("isValidDescription", () => {
  it("accepts 1 to 1024 characters", () => {
    expect(isValidDescription("Does a thing.")).toBe(true);
    expect(isValidDescription("x".repeat(1024))).toBe(true);
    expect(isValidDescription("")).toBe(false);
    expect(isValidDescription("x".repeat(1025))).toBe(false);
  });
});
