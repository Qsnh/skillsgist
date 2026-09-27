export function skillPath(skill: { project: string; slug: string }): string {
  return `/p/${skill.project}/s/${skill.slug}`;
}

export function projectSettingsPath(project: string): string {
  return `/p/${project}/settings`;
}

export function userSettingsPath(id: string): string {
  return `/admin/users/${id}`;
}
