import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render/markdown";

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

  // Regression tests for task-7 review finding 1: a blocklist regex
  // (`/^\s*(javascript|data|vbscript):/i`) only caught the scheme as one
  // contiguous substring, but the WHATWG URL Standard strips ASCII
  // tab/CR/LF from anywhere in a URL before parsing its scheme, so a
  // browser sees "javascript:" where the old regex didn't. These pin the
  // exact bypass payloads the reviewer ran against the vulnerable build.
  describe("dangerous-scheme obfuscation (task-7 review finding 1)", () => {
    it("strips a javascript: href obfuscated with a raw tab", async () => {
      const html = await renderMarkdown('<a href="java\tscript:alert(1)">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("strips a javascript: href obfuscated with a raw newline", async () => {
      const html = await renderMarkdown('<a href="java\nscript:alert(1)">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("strips a javascript: href obfuscated with an HTML tab entity", async () => {
      const html = await renderMarkdown('<a href="java&#9;script:alert(1)">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("strips a data: href obfuscated with a raw tab", async () => {
      const html = await renderMarkdown('<a href="da\tta:text/html,evil">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("strips a data: href obfuscated with an HTML tab entity", async () => {
      const html = await renderMarkdown('<a href="da&#9;ta:text/html,evil">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("strips a vbscript: href obfuscated with a raw tab", async () => {
      const html = await renderMarkdown('<a href="vb\tscript:msgbox(1)">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("strips a vbscript: href obfuscated with an HTML tab entity", async () => {
      const html = await renderMarkdown('<a href="vb&#9;script:msgbox(1)">click</a>');
      expect(html).not.toContain("href=");
      expect(html).toContain("click");
    });

    it("keeps an https: link intact", async () => {
      const html = await renderMarkdown('<a href="https://example.com/docs">click</a>');
      expect(html).toContain('href="https://example.com/docs"');
    });

    it("keeps a mailto: link intact", async () => {
      const html = await renderMarkdown('<a href="mailto:test@example.com">email</a>');
      expect(html).toContain('href="mailto:test@example.com"');
    });

    it("keeps a relative link intact", async () => {
      const html = await renderMarkdown('<a href="/docs/getting-started">rel</a>');
      expect(html).toContain('href="/docs/getting-started"');
    });
  });

  // Regression test for task-7 review finding 2: `style` was never
  // inspected, so `style="background:url(...)"` could beacon out to an
  // attacker-controlled host on every page view.
  it("strips the style attribute", async () => {
    const html = await renderMarkdown('<div style="background:url(https://evil.example/beacon)">hi</div>');
    expect(html).not.toContain("style=");
    expect(html).toContain("hi");
  });

  // A blocked tag other than script/iframe, to confirm el.remove() taking
  // children with it isn't special-cased to just those two tags.
  it("strips form/input and their content together", async () => {
    const html = await renderMarkdown("before<form><input value=\"stolen\"></form>after");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("stolen");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });
});
