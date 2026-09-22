import { marked } from "marked";

const BLOCKED_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input",
  "button", "link", "meta", "base", "svg", "math",
]);

// Attributes that can carry a URL. Most of their host elements are already
// in BLOCKED_TAGS (form/input/button/object/iframe), but we check the
// attribute regardless of tag so the two lists don't have to be kept in
// lockstep — an element added to allowed content later is still covered.
const URL_ATTRS = new Set([
  "href", "src", "srcset", "action", "formaction", "poster", "background",
  "cite", "ping", "data", "longdesc", "xlink:href",
]);

// A blocklist against scheme obfuscation is a losing game (see the task-7
// review: the previous regex was bypassed by control characters embedded in
// the scheme, in both raw and HTML-entity form). Use an allowlist instead:
// only these schemes may be *present*; a value with no scheme at all
// (relative paths, "#fragment", "?query") is allowed through unchanged.
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// The WHATWG URL Standard strips ASCII tab/CR/LF from anywhere in a URL
// before parsing its scheme, so "java\tscript:alert(1)" is "javascript:" to
// a browser even though it isn't one contiguous substring. Match the same
// control-character range (and its common HTML-entity spellings, which
// reach this code undecoded) before extracting the scheme, so the decision
// is made on what the browser will actually see.
const CONTROL_CHAR_RE = /[\x00-\x20]/g;
const CONTROL_ENTITY_RE = /&(?:#x0*9|#0*9|tab|#x0*a|#0*10|newline|#x0*d|#0*13);?/gi;

function normalizeForSchemeCheck(value: string): string {
  return value.replace(CONTROL_ENTITY_RE, "").replace(CONTROL_CHAR_RE, "");
}

// Values like srcset carry a comma-separated list of URLs; splitting on ","
// and checking every segment catches a dangerous scheme anywhere in the
// list, not just one that happens to lead the string. For single-URL
// attributes this is a harmless no-op (one segment, itself).
function isSafeUrlValue(value: string): boolean {
  const normalized = normalizeForSchemeCheck(value);
  return normalized.split(",").every((segment) => {
    const match = SCHEME_RE.exec(segment);
    if (!match) return true;
    const scheme = match[0].slice(0, -1).toLowerCase();
    return SAFE_SCHEMES.has(scheme);
  });
}

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
          // Redundant — the tokenizer already lowercases attribute names —
          // but harmless, so left as-is (task-7 review, deferred).
          if (name.toLowerCase().startsWith("on")) {
            el.removeAttribute(name);
            continue;
          }
          if (name === "style") {
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
