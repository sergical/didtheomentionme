import { expect, test } from "bun:test";
import { renderPage, type PageData } from "../src/page";
import { resultPath, shareTitle } from "../src/share";

const source = { id: "prime", name: "Prime", avatar: "https://example.com/avatar.jpg", hue: 55, coverage: { videos: 1, from: null, to: null } };
const data: PageData = {
  source, sources: [source], input: { handle: "theo", tweet: "", source: "prime" },
  result: { source, handle: "theo", coverage: source.coverage, matches: [{ videoId: "abc", title: "Video <title>", publishedAt: null, handle: "@theo", displayName: null, text: "A post", firstSeen: 12, lastSeen: 20, times: [12, 40], frameUrl: "/frame/abc/12.jpg", exact: false, readAloud: { at: 14, quote: "A post", reading: "all" } }] },
};

test("all video entry points open a safe new tab with a screen reader hint", () => {
  const html = renderPage(data);
  const links = [...html.matchAll(/<a\b[^>]*href="https:\/\/www.youtube.com[^>]*>/g)];
  expect(links).toHaveLength(5);
  for (const [link] of links) {
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain('aria-describedby="new-tab-hint"');
  }
  expect(html).toContain('id="new-tab-hint"');
});

test("result metadata and share controls use the same absolute result URL", () => {
  const html = renderPage(data);
  expect(html).toContain('data-url="https://didtheomention.me/?handle=theo&amp;source=prime"');
  expect(html).toContain('property="og:image" content="https://didtheomention.me/og.png?handle=theo&amp;source=prime"');
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  expect(html).toContain('Prime showed @theo 2 times.');
  expect(html).toContain("Prime showed your post and read it aloud.");
  expect(html).toContain('Video &lt;title&gt;');
  expect(shareTitle("Prime", data.result)).toBe("Prime showed @theo 2 times.");
});

test("post and text URLs preserve query characters and creator", () => {
  expect(resultPath({ handle: "", tweet: "https://x.com/a/status/123?x=1&y=2" }, "prime")).toBe("/?tweet=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F123%3Fx%3D1%26y%3D2&source=prime");
  expect(resultPath({ handle: "", tweet: "", q: ' <script> & words ' }, "theo")).toBe("/?q=%3Cscript%3E+%26+words&source=theo");
});

test("a text search excerpt starts near the first matching word", () => {
  const match = { ...data.result!.matches[0], text: `${"filler words here ".repeat(10)}the needle is here`, overlap: 1 };
  const html = renderPage({ ...data, input: { handle: "", tweet: "", q: "needle", source: "prime" }, result: { ...data.result!, query: "needle", matches: [match] } });
  expect(html).toMatch(/<p class="excerpt">…[^<]{0,60}<mark>needle<\/mark> is here<\/p>/);
  expect(html).toContain('<span class="sr-only">On screen at </span>');
});

test("the verdict and the card say how much was read", () => {
  const [first] = data.result!.matches;
  const render = (...readings: ("all" | "part" | "comment" | null)[]) => renderPage({ ...data, result: { ...data.result!, matches: readings.map((reading, i) => ({
    ...first, videoId: `v${i}`, readAloud: reading && { at: 14, quote: "Back to what they said", reading },
  })) } });
  expect(render("part")).toContain("Prime showed your post and read part of it aloud.");
  expect(render("part")).toContain("Prime read part of it aloud at");
  expect(render("comment")).toContain("Prime showed your post and talked about it, but did not read it aloud.");
  expect(render("comment")).toContain('<figure class="said comment">');
  expect(render("all", "comment", null)).toContain("Prime showed 3 of your posts, read 1 aloud and talked about 1.");
  expect(render(null, null)).toContain("Prime showed 2 of your posts, but did not read them aloud.");
});
