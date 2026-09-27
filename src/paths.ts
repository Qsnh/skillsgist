export function projectPath(project: string): string {
  return `/p/${project}`;
}

export function skillPath(skill: { project: string; slug: string }): string {
  return `${projectPath(skill.project)}/s/${skill.slug}`;
}

export function projectSettingsPath(project: string): string {
  return `${projectPath(project)}/settings`;
}

export function installKeyPath(key: string): string {
  return `/i/${key}`;
}

export function installBase(
  origin: string,
  project: string,
  installKey: string | undefined,
  publicReachable: boolean,
): string | null {
  if (installKey) return `${origin}${installKeyPath(installKey)}`;
  return publicReachable ? `${origin}${projectPath(project)}` : null;
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

export function returnPath(method: string, url: string, referer: string | undefined): string {
  const current = new URL(url);
  if (method === "GET" || method === "HEAD") return safeNext(`${current.pathname}${current.search}`);
  if (!referer) return "/";
  try {
    const from = new URL(referer);
    return from.origin === current.origin ? safeNext(`${from.pathname}${from.search}`) : "/";
  } catch {
    return "/";
  }
}
