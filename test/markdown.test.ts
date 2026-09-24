import { describe, expect, it } from "vitest";
import { renderMarkdown, renderSkillMd } from "../src/render/markdown";

/**
 * An href the sanitizer must drop: the attribute is gone, the link text
 * survives. Every payload below is checked through this one assertion pair,
 * so tightening what "dropped" means is a single edit.
 */
async function expectHrefDropped(href: string) {
  const html = await renderMarkdown(`<a href="${href}">click</a>`);
  expect(html).not.toContain("href=");
  expect(html).toContain("click");
}

/** An href the sanitizer must leave exactly as written. */
async function expectHrefKept(href: string) {
  const html = await renderMarkdown(`<a href="${href}">link</a>`);
  expect(html).toContain(`href="${href}"`);
}

describe("renderMarkdown", () => {
  it("renders headings and code blocks", async () => {
    const html = await renderMarkdown("# Title\n\n```js\nconst a = 1;\n```\n");
    expect(html).toContain("<h1");
    expect(html).toContain("const a = 1;");
  });

  it("strips script tags and their content", async () => {
    const html = await renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("strips inline event handlers", async () => {
    const html = await renderMarkdown('<div onclick="steal()">hi</div>');
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });

  it("strips javascript: links", async () => {
    const html = await renderMarkdown('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("strips iframes", async () => {
    const html = await renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("keeps ordinary links intact", async () => {
    const html = await renderMarkdown("[docs](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("escapes code-fence content rather than executing it", async () => {
    const html = await renderMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  // A blocklist regex (`/^\s*(javascript|data|vbscript):/i`) only caught the
  // scheme as one contiguous substring, but the WHATWG URL Standard strips
  // ASCII tab/CR/LF from anywhere in a URL before parsing its scheme, so a
  // browser sees "javascript:" where such a regex doesn't. These pin the exact
  // bypass payloads that defeated it.
  describe("dangerous-scheme obfuscation", () => {
    it.each([
      ["a javascript: href obfuscated with a raw tab", "java\tscript:alert(1)"],
      ["a javascript: href obfuscated with a raw newline", "java\nscript:alert(1)"],
      ["a javascript: href obfuscated with an HTML tab entity", "java&#9;script:alert(1)"],
      ["a data: href obfuscated with a raw tab", "da\tta:text/html,evil"],
      ["a data: href obfuscated with an HTML tab entity", "da&#9;ta:text/html,evil"],
      ["a vbscript: href obfuscated with a raw tab", "vb\tscript:msgbox(1)"],
      ["a vbscript: href obfuscated with an HTML tab entity", "vb&#9;script:msgbox(1)"],
    ])("strips %s", (_label, href) => expectHrefDropped(href));

    it.each([
      "https://example.com/docs",
      "mailto:test@example.com",
      "/docs/getting-started",
    ])("keeps %s intact", (href) => expectHrefKept(href));
  });

  // Extracting the scheme with a character-class regex fails to match — and so
  // falls through to "no scheme, allow" — whenever an HTML character reference
  // (named or numeric, semicolon or not) appears in the scheme segment.
  // Browsers decode character references in attribute values during
  // tokenization, before any URL parsing, so these all reconstruct a live
  // dangerous URL by the time a visitor's browser renders the stored HTML.
  // Each must assert the attribute is gone, not merely that the literal
  // scheme substring is absent.
  describe("dangerous-scheme obfuscation via character references", () => {
    it.each([
      ["a named entity encoding the colon", "javascript&colon;alert(1)"],
      ["a numeric entity encoding the colon", "javascript&#58;alert(1)"],
      ["a numeric entity missing its trailing semicolon", "javascript&#58alert(1)"],
      ["a hex numeric entity encoding the colon", "javascript&#x3a;alert(1)"],
      ["a data: scheme with a named entity encoding the colon", "data&colon;text/html,evil"],
      ["a scheme letter (not the colon) entity-encoded", "&#106;avascript:alert(1)"],
    ])("strips an href with %s", (_label, href) => expectHrefDropped(href));

    it("strips a srcset with a named entity encoding the colon", async () => {
      const html = await renderMarkdown('<img srcset="javascript&colon;alert(1) 1x">');
      expect(html).not.toContain("srcset=");
    });

    it.each([
      "?a=1&b=2",
      "#frag&x",
      "page.html?a=1&b=2",
      "https://example.com/a?b=1&c=2",
    ])("keeps the relative or https href %s intact", (href) => expectHrefKept(href));
  });

  // An uninspected `style` lets `style="background:url(...)"` beacon out to an
  // attacker-controlled host on every page view.
  it("strips the style attribute", async () => {
    const html = await renderMarkdown('<div style="background:url(https://evil.example/beacon)">hi</div>');
    expect(html).not.toContain("style=");
    expect(html).toContain("hi");
  });

  // A blocked tag other than script/iframe, to confirm el.remove() taking
  // children with it isn't special-cased to just those two tags. `form` is
  // not on ALLOWED_TAGS, so it's still removed; the nested `input`
  // is now individually allowed (GFM task lists emit one), but it never
  // gets a chance to survive on its own because removing `form` drops its
  // entire subtree regardless of what any nested element's own handler
  // would have decided.
  it("strips form/input and their content together", async () => {
    const html = await renderMarkdown("before<form><input value=\"stolen\"></form>after");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("stolen");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  // Spec §10 requires an allowlist for the tag layer, matching what the
  // attribute layer already does. These pin that ordinary markdown constructs
  // still render correctly under it, and that unlisted elements are removed by
  // default rather than passing through.
  describe("tag allowlist", () => {
    it("keeps every ordinary markdown construct intact", async () => {
      const md = [
        "# H1",
        "",
        "## H2",
        "",
        "A paragraph with **bold**, *em*, and `inline code`.",
        "",
        "```js",
        "const a = 1;",
        "```",
        "",
        "[a link](https://example.com/x)",
        "",
        "![alt text](https://example.com/img.png)",
        "",
        "> a blockquote",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "- [ ] todo item",
        "- [x] done item",
        "",
      ].join("\n");
      const html = await renderMarkdown(md);

      expect(html).toContain("<h1>H1</h1>");
      expect(html).toContain("<h2>H2</h2>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>em</em>");
      expect(html).toContain("<code>inline code</code>");
      expect(html).toContain("<pre>");
      expect(html).toContain("const a = 1;");
      expect(html).toContain('href="https://example.com/x"');
      expect(html).toContain('<img src="https://example.com/img.png" alt="alt text">');
      expect(html).toContain("<blockquote>");
      expect(html).toContain("<p>a blockquote</p>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>one</li>");
      expect(html).toContain("<ol>");
      expect(html).toContain("<li>first</li>");
      expect(html).toContain("<table>");
      expect(html).toContain("<thead>");
      expect(html).toContain("<tbody>");
      expect(html).toContain("<th>A</th>");
      expect(html).toContain("<td>1</td>");
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("todo item");
      expect(html).toContain("done item");
    });

    it("removes an unlisted element (marquee) and its children", async () => {
      const html = await renderMarkdown("before<marquee>scrolling <b>text</b></marquee>after");
      expect(html).not.toContain("<marquee");
      expect(html).not.toContain("scrolling");
      expect(html).toContain("before");
      expect(html).toContain("after");
    });

    it("removes an unlisted element (object) and its children", async () => {
      const html = await renderMarkdown('before<object data="https://evil.example/x.swf">fallback</object>after');
      expect(html).not.toContain("<object");
      expect(html).not.toContain("fallback");
      expect(html).toContain("before");
      expect(html).toContain("after");
    });

    it("removes an unlisted element (form) and its children", async () => {
      const html = await renderMarkdown('before<form action="/steal"><b>gone</b></form>after');
      expect(html).not.toContain("<form");
      expect(html).not.toContain("gone");
      expect(html).toContain("before");
      expect(html).toContain("after");
    });
  });
});

describe("renderSkillMd", () => {
  it("drops the frontmatter and renders the body", async () => {
    const html = await renderSkillMd("---\nname: demo-skill\ndescription: A demo skill.\n---\n\n# Demo\n\nBody.\n");
    expect(html).not.toContain("name: demo-skill");
    expect(html).not.toContain("<hr");
    expect(html).toContain("<h1>Demo</h1>");
    expect(html).toContain("<p>Body.</p>");
  });

  it("drops CRLF frontmatter", async () => {
    const html = await renderSkillMd("---\r\nname: demo-skill\r\ndescription: A demo skill.\r\n---\r\n\r\n# Demo\r\n");
    expect(html).not.toContain("name: demo-skill");
    expect(html).toContain("<h1>Demo</h1>");
  });

  it("keeps a body that starts right after the closing fence", async () => {
    const html = await renderSkillMd("---\nname: demo-skill\ndescription: A demo skill.\n---\nFirst line.\n");
    expect(html).toContain("<p>First line.</p>");
  });

  it("keeps thematic breaks inside the body", async () => {
    const html = await renderSkillMd("---\nname: demo-skill\ndescription: A demo skill.\n---\n\nAbove\n\n---\n\nBelow\n");
    expect(html).toContain("<hr>");
    expect(html).toContain("<p>Above</p>");
    expect(html).toContain("<p>Below</p>");
  });

  it("still sanitizes the body", async () => {
    const html = await renderSkillMd("---\nname: demo-skill\ndescription: A demo skill.\n---\n\n<script>alert(1)</script>\n");
    expect(html).not.toContain("<script");
  });
});
