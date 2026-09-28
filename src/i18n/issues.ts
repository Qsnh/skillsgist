import { en } from "./en";
import type { Messages } from "./en";

type PublishErrors = Messages["publishErrors"];

type IssueKey = keyof PublishErrors;

export interface Issue {
  key: IssueKey;
  args: unknown[];
}

export function issue<K extends IssueKey>(key: K, ...args: Parameters<PublishErrors[K]>): Issue {
  return { key, args };
}

export function issueText(t: Messages, found: Issue): string {
  const render = t.publishErrors[found.key] as (...args: unknown[]) => string;
  return render(...found.args);
}

export class IssueError extends Error {
  readonly issue: Issue;
  constructor(found: Issue) {
    super(issueText(en, found));
    this.issue = found;
  }
}
