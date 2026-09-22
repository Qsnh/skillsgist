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
// review, rounds 1 and 2: a regex requiring the scheme to be one intact
// substring was bypassed first by raw control characters embedded in the
// scheme, then by HTML character references — named or numeric, with or
// without a trailing semicolon, encoding either the colon or a scheme
// letter — which decode in a browser during attribute tokenization, before
// any URL parsing, but reached this code completely undecoded. Enumerating
// entity spellings is unwinnable, so this uses an allowlist that never
// tries to decode a character reference at all: any "&" found where a
// scheme would be is treated as disqualifying on its own.
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

// The WHATWG URL Standard strips ASCII tab/CR/LF from anywhere in a URL
// before parsing its scheme, so "java\tscript:alert(1)" is "javascript:" to
// a browser even though it isn't one contiguous substring in the source.
const CONTROL_CHAR_RE = /[\x00-\x20]/g;

// A URL's scheme, if any, always precedes its first "/", "?", or "#" — so
// everything after that point (path, query, fragment) is irrelevant to
// which scheme it is and is left uninspected.
const HEAD_DELIMITER_RE = /[/?#]/;

function isSafeUrlSegment(segment: string): boolean {
  const normalized = segment.replace(CONTROL_CHAR_RE, "");
  const delimiterIndex = normalized.search(HEAD_DELIMITER_RE);
  const head = delimiterIndex === -1 ? normalized : normalized.slice(0, delimiterIndex);

  // A legitimate URL never needs a character reference in its scheme
  // segment. Rejecting on sight closes the whole obfuscation class at once
  // — encoded colon, encoded scheme letter, semicolon-less numeric forms,
  // and anything not yet seen — rather than trying to decode and recognize
  // each spelling.
  if (head.includes("&")) return false;

  const colonIndex = head.indexOf(":");
  if (colonIndex === -1) return true; // no scheme: relative path, #fragment, ?query
  const scheme = head.slice(0, colonIndex).toLowerCase();
  return SAFE_SCHEMES.has(scheme);
}

// Values like srcset carry a comma-separated list of URLs; checking every
// segment catches a dangerous scheme anywhere in the list, not just one
// that happens to lead the string. For single-URL attributes this is a
// harmless no-op (one segment, itself).
function isSafeUrlValue(value: string): boolean {
  return value.split(",").every(isSafeUrlSegment);
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
