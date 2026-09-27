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
  it.each([
    ["inline event handlers", '<div onclick="steal()">hi</div>', "onclick"],
    ["the style attribute", '<div style="background:url(https://evil.example/beacon)">hi</div>', "style="],
  ])("strips %s", async (_label, md, attr) => {
    const html = await renderMarkdown(md);
    expect(html).not.toContain(attr);
    expect(html).toContain("hi");
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
      ["a plain javascript: href", "javascript:alert(1)"],
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

      for (const fragment of [
        "<h1>H1</h1>", "<h2>H2</h2>", "<strong>bold</strong>", "<em>em</em>", "<code>inline code</code>", "<pre>",
        "const a = 1;", 'href="https://example.com/x"', '<img src="https://example.com/img.png" alt="alt text">',
        "<blockquote>", "<p>a blockquote</p>", "<ul>", "<li>one</li>", "<ol>", "<li>first</li>", "<table>", "<thead>",
        "<tbody>", "<th>A</th>", "<td>1</td>", 'type="checkbox"', "todo item", "done item",
      ]) expect(html).toContain(fragment);
    });

    it.each([
      ["a script element", "before\n\n<script>alert(1)</script>\n\nafter", ["<script", "alert(1)"], ["before", "after"]],
      ["an iframe", '<iframe src="https://evil.example"></iframe>', ["<iframe"], []],
      ["a form and the input inside it", 'before<form><input value="stolen"></form>after', ["<form", "<input", "stolen"], ["before", "after"]],
      ["an unlisted marquee element", "before<marquee>scrolling <b>text</b></marquee>after", ["<marquee", "scrolling"], ["before", "after"]],
      ["an unlisted object element", 'before<object data="https://evil.example/x.swf">fallback</object>after', ["<object", "fallback"], ["before", "after"]],
      ["an unlisted form element", 'before<form action="/steal"><b>gone</b></form>after', ["<form", "gone"], ["before", "after"]],
    ])("removes %s along with everything inside it", async (_label, md, gone, kept) => {
      const html = await renderMarkdown(md);
      for (const text of gone) expect(html).not.toContain(text);
      for (const text of kept) expect(html).toContain(text);
    });
  });
});

describe("renderSkillMd", () => {
  const FM = "---\nname: demo-skill\ndescription: A demo skill.\n---\n";

  it.each([
    ["drops the frontmatter and renders the body", `${FM}\n# Demo\n\nBody.\n`, ["<h1>Demo</h1>", "<p>Body.</p>"], ["name: demo-skill", "<hr"]],
    ["drops CRLF frontmatter", "---\r\nname: demo-skill\r\ndescription: A demo skill.\r\n---\r\n\r\n# Demo\r\n", ["<h1>Demo</h1>"], ["name: demo-skill"]],
    ["keeps a body that starts right after the closing fence", `${FM}First line.\n`, ["<p>First line.</p>"], []],
    ["keeps thematic breaks inside the body", `${FM}\nAbove\n\n---\n\nBelow\n`, ["<hr>", "<p>Above</p>", "<p>Below</p>"], []],
    ["still sanitizes the body", `${FM}\n<script>alert(1)</script>\n`, [], ["<script"]],
  ])("%s", async (_label, md, present, absent) => {
    const html = await renderSkillMd(md);
    for (const text of present) expect(html).toContain(text);
    for (const text of absent) expect(html).not.toContain(text);
  });
});
