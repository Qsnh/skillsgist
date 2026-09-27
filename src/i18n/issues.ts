import type { Messages } from "./en";

type PublishErrors = Messages["publishErrors"];

export type IssueKey = keyof PublishErrors;

export interface Issue<K extends IssueKey = IssueKey> {
  key: K;
  args: Parameters<PublishErrors[K]>;
}

export function issue<K extends IssueKey>(key: K, ...args: Parameters<PublishErrors[K]>): Issue<K> {
  return { key, args };
}

export function issueText(t: Messages, found: Issue): string {
  const render = t.publishErrors[found.key] as (...args: unknown[]) => string;
  return render(...found.args);
}
