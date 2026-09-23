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
 * baseUrl is https://host or https://host/i/<key>; artifact addresses are
 * appended to it directly. Entries that fail the CLI's validation rules are
 * dropped — better one entry short than handing the CLI half a broken index.
 */
export function buildIndex(
  rows: IndexSource[],
  baseUrl: string,
): { $schema: string; skills: IndexEntry[] } {
  const skills: IndexEntry[] = [];
  for (const row of rows) {
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
