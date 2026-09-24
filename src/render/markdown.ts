import { marked } from "marked";
import { stripFrontmatter } from "../skills/frontmatter";

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s",
  "code", "pre", "blockquote", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tfoot",
  "tr", "th", "td", "kbd", "sup", "sub", "details", "summary", "dl", "dt", "dd", "abbr", "figure",
  "figcaption", "span", "div", "input",
]);

const URL_ATTRS = new Set([
  "href", "src", "srcset", "action", "formaction", "poster", "background",
  "cite", "ping", "data", "longdesc", "xlink:href",
]);

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

const CONTROL_CHAR_RE = /[\x00-\x20]/g;

const HEAD_DELIMITER_RE = /[/?#]/;

function isSafeUrlSegment(segment: string): boolean {
  const normalized = segment.replace(CONTROL_CHAR_RE, "");
  const delimiterIndex = normalized.search(HEAD_DELIMITER_RE);
  const head = delimiterIndex === -1 ? normalized : normalized.slice(0, delimiterIndex);

  if (head.includes("&")) return false;

  const colonIndex = head.indexOf(":");
  if (colonIndex === -1) return true; // no scheme: relative path, #fragment, ?query
  const scheme = head.slice(0, colonIndex).toLowerCase();
  return SAFE_SCHEMES.has(scheme);
}

function isSafeUrlValue(value: string): boolean {
  return value.split(",").every(isSafeUrlSegment);
}

export async function renderMarkdown(md: string): Promise<string> {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;

  const rewritten = new HTMLRewriter()
    .on("*", {
      element(el) {
        if (!ALLOWED_TAGS.has(el.tagName)) {
          el.remove();
          return;
        }
        for (const [name, value] of [...el.attributes]) {
          if (name === "style" || name.startsWith("on")) {
            el.removeAttribute(name);
            continue;
          }
          if (URL_ATTRS.has(name) && !isSafeUrlValue(value)) {
            el.removeAttribute(name);
          }
        }
      },
    })
    .transform(new Response(html));

  return await rewritten.text();
}

export const RENDER_REVISION = 1;

export function renderSkillMd(skillMd: string): Promise<string> {
  return renderMarkdown(stripFrontmatter(skillMd));
}
