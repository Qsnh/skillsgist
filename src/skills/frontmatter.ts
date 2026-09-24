import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(src);
  if (!match) return { data: {}, body: src };
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    data = {};
  }
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  return { data: record, body: src.slice(match[0].length) };
}

export function stripFrontmatter(src: string): string {
  return src.replace(FRONTMATTER, "");
}

export function isValidSkillName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > 64) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("-")) return false;
  if (name.includes("--")) return false;
  return true;
}

export function isValidDescription(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
