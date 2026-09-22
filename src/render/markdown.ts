import { marked } from "marked";

// An allowlist, not a blocklist: it doesn't have to guess every dangerous tag
// in advance, and since published HTML is sanitized once and stored, a tag
// nobody thought to block would never be retroactively cleaned from the
// database. `form` is deliberately absent — that is what makes the allowed
// `input` (GFM task-list checkboxes) inert.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s",
  "code", "pre", "blockquote", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tfoot",
  "tr", "th", "td", "kbd", "sup", "sub", "details", "summary", "dl", "dt", "dd", "abbr", "figure",
  "figcaption", "span", "div", "input",
]);

// Attributes that can carry a URL. The elements that normally carry one —
// form, button, object, iframe — are already absent from ALLOWED_TAGS, and
// `input` uses none of these. Checked regardless of tag anyway, so the two
// lists need not stay in lockstep: a tag allowed later is still covered.
const URL_ATTRS = new Set([
  "href", "src", "srcset", "action", "formaction", "poster", "background",
  "cite", "ping", "data", "longdesc", "xlink:href",
]);

// Blocklisting schemes is a losing game: a regex demanding one intact
// substring falls to raw control characters in the scheme, and then to HTML
// character references (named or numeric, semicolon or not, encoding the
// colon or a scheme letter) that a browser decodes during attribute
// tokenization — before any URL parsing — but that reach this code undecoded.
// Enumerating entity spellings is unwinnable, so this allowlists instead and
// never decodes at all; see the "&" rule in isSafeUrlSegment.
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

  // A legitimate URL never needs a character reference in its scheme segment.
  // Rejecting on sight closes the whole obfuscation class at once — encoded
  // colon, encoded scheme letter, semicolon-less numeric forms, and whatever
  // has not been seen yet.
  if (head.includes("&")) return false;

  const colonIndex = head.indexOf(":");
  if (colonIndex === -1) return true; // no scheme: relative path, #fragment, ?query
  const scheme = head.slice(0, colonIndex).toLowerCase();
  return SAFE_SCHEMES.has(scheme);
}

// srcset and friends carry a comma-separated list, so a dangerous scheme can
// hide anywhere in it, not just at the front. A no-op for single-URL values.
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
        // Snapshot first: this HTMLRewriter build invalidates the live
        // attribute iterator on the first mid-iteration removeAttribute.
        for (const [name, value] of [...el.attributes]) {
          // The tokenizer already lowercased `name`.
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
