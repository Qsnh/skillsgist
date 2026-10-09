export const PROJECT_SLUG = /^[a-z0-9-]{2,32}$/;

export function projectPath(project: string): string {
  return `/p/${project}`;
}

export function skillPath(skill: { project: string; slug: string }): string {
  return `${projectPath(skill.project)}/s/${skill.slug}`;
}

export function projectSettingsPath(project: string): string {
  return `${projectPath(project)}/settings`;
}

export function userSettingsPath(id: string): string {
  return `/admin/users/${id}`;
}

const UNSAFE_IN_PATH = /[\u0000-\u001f\u007f\\]/;

export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || UNSAFE_IN_PATH.test(value)) {
    return "/";
  }
  return value;
}
