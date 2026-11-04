import { describe, expect, test } from "bun:test";
import { mergeRepeats, parseHandle, type Match } from "../src/lookup";

describe("parseHandle", () => {
  test.each([
    ["theo", "theo"],
    [" @theo ", "theo"],
    ["https://x.com/theo", "theo"],
    ["x.com/@theo?s=20", "theo"],
    ["https://twitter.com/ThePrimeagen/status/123", "ThePrimeagen"],
  ])("%p", (raw, handle) => expect(parseHandle(raw)).toBe(handle));

  test("a handle-less status link keeps the raw value", () => {
    expect(parseHandle("https://x.com/i/status/123")).toBe("https://x.com/i/status/123");
  });
});

const match = (over: Partial<Match>): Match => ({
  videoId: "v1",
  title: null,
  publishedAt: null,
  handle: "@ThePrimeagen",
  displayName: null,
  text: "After Astra released I once again am waiting for this 10x cheaper AI",
  firstSeen: 0,
  lastSeen: 0,
  times: [over.firstSeen ?? 0],
  frameUrl: "",
  exact: false,
  readAloud: null,
  ...over,
});

describe("mergeRepeats", () => {
  test("one post twice in a video becomes one match with both times", () => {
    const longer = "After Astra released I once again am waiting for this 10x cheaper AI per year to land";
    const merged = mergeRepeats([
      match({ firstSeen: 209, times: [209], text: longer }),
      match({ firstSeen: 59, times: [59], readAloud: { at: 62, quote: null } }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].times).toEqual([59, 209]);
    expect(merged[0].text).toBe(longer);
    expect(merged[0].readAloud?.at).toBe(62);
  });

  test("keeps different posts and other videos apart", () => {
    const merged = mergeRepeats([
      match({ firstSeen: 1 }),
      match({ firstSeen: 2, text: "Something else entirely about databases" }),
      match({ firstSeen: 3, videoId: "v2" }),
    ]);
    expect(merged).toHaveLength(3);
  });
});
