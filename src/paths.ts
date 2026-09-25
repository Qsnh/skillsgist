export function skillPath(skill: { project: string; slug: string }): string {
  return `/p/${skill.project}/s/${skill.slug}`;
}
