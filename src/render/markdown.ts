import { marked } from "marked";

const BLOCKED_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input",
  "button", "link", "meta", "base", "svg", "math",
]);

const DANGEROUS_URL = /^\s*(javascript|data|vbscript):/i;

export async function renderMarkdown(md: string): Promise<string> {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;

  const rewritten = new HTMLRewriter()
    .on("*", {
      element(el) {
        if (BLOCKED_TAGS.has(el.tagName)) {
          el.remove();
          return;
        }
        // Snapshot attributes before mutating: this HTMLRewriter build
        // invalidates the live attribute iterator as soon as removeAttribute
        // is called mid-iteration, so we iterate a plain array instead.
        for (const [name, value] of [...el.attributes]) {
          if (name.toLowerCase().startsWith("on")) {
            el.removeAttribute(name);
            continue;
          }
          if ((name === "href" || name === "src") && DANGEROUS_URL.test(value)) {
            el.removeAttribute(name);
          }
        }
      },
    })
    .transform(new Response(html));

  return await rewritten.text();
}
