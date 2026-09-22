import { artifactUrl, DIGEST_PREFIX } from "./artifact";
import { isValidDescription, isValidSkillName } from "./skills/frontmatter";

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const DIGEST_RE = new RegExp(`^${DIGEST_PREFIX}[a-f0-9]{64}$`);

export interface IndexEntry {
  name: string;
  description: string;
  type: "archive";
  url: string;
  digest: string;
}

export interface IndexSource {
  slug: string;
  description: string;
  digest: string;
}

/**
 * baseUrl 形如 https://host 或 https://host/i/<key>，产物地址直接拼在它后面。
 * 不满足 CLI 校验规则的条目会被丢弃 —— 宁可少一条，也不要让 CLI 拿到半个坏 index。
 */
export function buildIndex(
  rows: IndexSource[],
  baseUrl: string,
): { $schema: string; skills: IndexEntry[] } {
  const skills: IndexEntry[] = [];
  for (const row of rows) {
    // Spec §9 requires a warning when a row
    // is dropped, so an operator has some signal if this branch is ever
    // reached — normalizeUpload already enforces these same checks at
    // publish time, so in practice this is defense-in-depth, but silence
    // here previously meant zero visibility if it ever did trigger.
    if (!isValidSkillName(row.slug)) {
      console.warn(`buildIndex: dropping row for slug ${row.slug}: invalid name`);
      continue;
    }
    if (!isValidDescription(row.description)) {
      console.warn(`buildIndex: dropping row for slug ${row.slug}: invalid description`);
      continue;
    }
    if (!DIGEST_RE.test(row.digest)) {
      console.warn(`buildIndex: dropping row for slug ${row.slug}: malformed digest`);
      continue;
    }
    skills.push({
      name: row.slug,
      description: row.description,
      type: "archive",
      url: artifactUrl(baseUrl, row.slug, row.digest),
      digest: row.digest,
    });
  }
  return { $schema: DISCOVERY_SCHEMA, skills };
}
