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
});
