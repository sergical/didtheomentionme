import { describe, expect, test } from "bun:test";
import {
  buildWindow,
  frameSeconds,
  frameTimeline,
  inheritProbabilities,
  expandSentence,
  findRuns,
  formatTime,
  groupPosts,
  jaccard,
  overlap,
  parseReaderLines,
  pickSeconds,
  sameHandle,
  timeAtOffset,
  wordsFromSegments,
} from "../src/pipeline";
import { parseTweetId, syndicationToken } from "../src/tweet";

const probsAt = (length: number, hits: number[]) => Array.from({ length }, (_, i) => (hits.includes(i) ? 0.9 : 0.1));

describe("findRuns", () => {
  test("merges hits at most 3 seconds apart", () => {
    expect(findRuns(probsAt(30, [10, 11, 13, 20]), 0.5)).toEqual([
      { start: 10, end: 13 },
      { start: 20, end: 20 },
    ]);
  });

  test("splits when the gap is 4 seconds", () => {
    expect(findRuns(probsAt(30, [10, 14]), 0.5)).toEqual([
      { start: 10, end: 10 },
      { start: 14, end: 14 },
    ]);
  });

  test("threshold is inclusive", () => {
    expect(findRuns([0.49, 0.5], 0.5)).toEqual([{ start: 1, end: 1 }]);
  });

  test("no hits gives no runs", () => {
    expect(findRuns([0, 0, 0], 0.5)).toEqual([]);
  });
});

describe("pickSeconds", () => {
  test("every 5 seconds from the start, plus the end", () => {
    expect(pickSeconds({ start: 100, end: 112 })).toEqual([100, 105, 110, 112]);
  });

  test("does not repeat the end when it lands on a pick", () => {
    expect(pickSeconds({ start: 100, end: 110 })).toEqual([100, 105, 110]);
  });

  test("single-second run", () => {
    expect(pickSeconds({ start: 7, end: 7 })).toEqual([7]);
  });
});

describe("parseReaderLines", () => {
  test("keeps a valid line", () => {
    expect(parseReaderLines("@ThePrimeagen | ThePrimeagen | tested out Haiku vs Luna")).toEqual([
      { handle: "@ThePrimeagen", displayName: "ThePrimeagen", text: "tested out Haiku vs Luna" },
    ]);
  });

  test("rejects handles with spaces or dots", () => {
    const output = ["@Pipkin Pippa | Pipkin | some text here", "@t3.gg | Theo | some text here"].join("\n");
    expect(parseReaderLines(output)).toEqual([]);
  });

  test("rejects handles longer than 15 characters and short text", () => {
    const output = ["@abcdefghijklmnop | Name | long handle text", "@theo | Theo | ?"].join("\n");
    expect(parseReaderLines(output)).toEqual([]);
  });

  test("keeps pipes inside the post text and ignores prose lines", () => {
    const output = "Here are the posts:\n@theo | Theo | a | b | c";
    expect(parseReaderLines(output)).toEqual([{ handle: "@theo", displayName: "Theo", text: "a | b | c" }]);
  });
});

describe("jaccard", () => {
  test("identical texts score 1, disjoint texts 0", () => {
    expect(jaccard("Haiku is fast", "haiku IS fast")).toBe(1);
    expect(jaccard("one two", "three four")).toBe(0);
  });
});

describe("groupPosts", () => {
  const line = (handle: string, text: string, displayName = "Name") => ({ handle, displayName, text });

  test("makes one group per handle and keeps each distinct slice of text", () => {
    const groups = groupPosts([
      { second: 100, line: line("@Theo", "Anthropic has no small model") },
      { second: 105, line: line("@theo", "Anthropic has no small model anymore, right") },
      { second: 110, line: line("@Theo", "Anthropic has no small model anymore, right") },
      { second: 105, line: line("@theo", "something completely different here") },
    ]);
    expect(groups).toEqual([
      {
        handle: "@Theo",
        displayName: "Name",
        text: "Anthropic has no small model anymore, right\nsomething completely different here",
        slices: ["Anthropic has no small model anymore, right", "something completely different here"],
        firstSeen: 100,
        lastSeen: 110,
        frameSecond: 100,
      },
    ]);
  });

  test("merges misread spellings of one handle under the most common one", () => {
    const groups = groupPosts([
      { second: 509, line: line("@lydhahallie", "a") },
      { second: 514, line: line("@lydiahallie", "a") },
      { second: 519, line: line("@lydiahallie", "a") },
      { second: 1108, line: line("@gautamgoel978", "b") },
      { second: 1113, line: line("@gautamgoel978", "b") },
      { second: 1128, line: line("@gautamgoel", "b") },
    ]);
    expect(groups.map((g) => [g.handle, g.firstSeen, g.lastSeen])).toEqual([
      ["@lydiahallie", 509, 519],
      ["@gautamgoel978", 1108, 1128],
    ]);
  });

  test("keeps different handles apart even with the same text", () => {
    const groups = groupPosts([
      { second: 1, line: line("@a", "same text here") },
      { second: 2, line: line("@b", "same text here") },
    ]);
    expect(groups.map((g) => g.handle)).toEqual(["@a", "@b"]);
  });

  test("joins a misread handle to the group with the same post text", () => {
    const post = "She strives to be a power user of every tool she touches and writes about it";
    const groups = groupPosts([
      { second: 1920, line: line("@poteto", post) },
      { second: 1925, line: line("@lauren", `${post} every week`, "Lauren") },
      { second: 1930, line: line("@poteto", post) },
    ]);
    expect(groups.map((g) => [g.handle, g.firstSeen, g.lastSeen])).toEqual([["@poteto", 1920, 1930]]);
  });

  test("a placeholder handle joins by text, or keeps its own group", () => {
    const post = "Placeholder handles come from the reader copying its output format";
    const [placeholder] = parseReaderLines(`@handle | display name | ${post}`);
    expect(placeholder).toEqual({ handle: "@unknown", displayName: "", text: post });
    const groups = groupPosts([
      { second: 1, line: placeholder },
      { second: 6, line: line("@theo", post) },
      { second: 11, line: { ...placeholder, text: "a different post that nobody can read the handle of" } },
    ]);
    expect(groups.map((g) => [g.handle, g.displayName, g.lastSeen])).toEqual([["@theo", "Name", 6], ["@unknown", "", 11]]);
  });

  test("orders by second regardless of input order", () => {
    const [group] = groupPosts([
      { second: 20, line: line("@a", "same text here") },
      { second: 10, line: line("@a", "same text here") },
    ]);
    expect(group.firstSeen).toBe(10);
    expect(group.frameSecond).toBe(10);
    expect(group.lastSeen).toBe(20);
  });
});

describe("transcript window", () => {
  const words: [number, string][] = [
    [10, "before"],
    [70, "hello"],
    [71.5, "there"],
    [73, "world"],
    [200, "after"],
  ];

  test("keeps words inside the window and records their offsets", () => {
    const w = buildWindow(words, 60, 100);
    expect(w.text).toBe("hello there world");
    expect(w.offsets).toEqual([
      [0, 70],
      [6, 71.5],
      [12, 73],
    ]);
  });

  test("maps a character offset to the last word starting at or before it", () => {
    const { offsets } = buildWindow(words, 60, 100);
    expect(timeAtOffset(offsets, 0)).toBe(70);
    expect(timeAtOffset(offsets, 8)).toBe(71.5);
    expect(timeAtOffset(offsets, 12)).toBe(73);
    expect(timeAtOffset(offsets, 999)).toBe(73);
  });

  test("decodes caption entities and drops speaker-change markers", () => {
    const w = buildWindow([[1, "&gt;&gt;"], [2, "Tom&#39;s"], [3, "A&amp;B"]], 0, 10);
    expect(w.text).toBe("Tom's A&B");
    expect(w.offsets).toEqual([
      [0, 2],
      [6, 3],
    ]);
  });
});

describe("sameHandle", () => {
  test("accepts small misreads and truncation of long handles only", () => {
    expect(sameHandle("@lydhahallie", "@lydiahallie")).toBe(true);
    expect(sameHandle("@gautamgoel", "@gautamgoel978")).toBe(true);
    expect(sameHandle("@theo", "@theo_t3")).toBe(false);
    expect(sameHandle("@theo", "@thea")).toBe(false);
    expect(sameHandle("@claudeai", "@ClaudeDevs".toLowerCase())).toBe(false);
  });
});

describe("expandSentence", () => {
  const text = "First one. The model costs less. It is also faster! Then a last bit.";

  test("expands to sentence punctuation", () => {
    const start = text.indexOf("costs");
    expect(expandSentence(text, start, start + 5)).toBe("The model costs less.");
  });

  test("stops at a question or exclamation mark", () => {
    const start = text.indexOf("faster");
    expect(expandSentence(text, start, start + 6)).toBe("It is also faster!");
  });

  test("caps at 120 characters on each side without cutting words", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const start = long.indexOf("word50");
    const quote = expandSentence(long, start, start + 6);
    expect(quote).toContain("word50");
    expect(quote.length).toBeLessThanOrEqual(6 + 240);
    expect(quote.split(" ").every((w) => /^word\d+$/.test(w))).toBe(true);
  });
});

describe("overlap", () => {
  test("share of query tokens found in the text", () => {
    expect(overlap(["haiku", "fast", "cheap", "model"], "Haiku is fast")).toBe(0.5);
    expect(overlap([], "anything")).toBe(0);
  });
});

describe("formatTime", () => {
  test("m:ss and h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(1108)).toBe("18:28");
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(7384)).toBe("2:03:04");
  });
});

describe("wordsFromSegments", () => {
  test("uses word timings with the chunk offset", () => {
    const words = wordsFromSegments(
      [{ start: 0, end: 2, text: " hi there", words: [{ word: " hi", start: 0.1, end: 0.4 }, { word: " there", start: 0.5, end: 1 }] }],
      600,
    );
    expect(words).toEqual([[600.1, "hi"], [600.5, "there"]]);
  });

  test("spreads words evenly when a segment has no word timings", () => {
    expect(wordsFromSegments([{ start: 10, end: 12, text: "a b c d" }], 0)).toEqual([
      [10, "a"],
      [10.5, "b"],
      [11, "c"],
      [11.5, "d"],
    ]);
  });
});

describe("tweet helpers", () => {
  test("syndication token follows the published formula", () => {
    const id = "2103034083127501079";
    const expected = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    expect(syndicationToken(id)).toBe(expected);
    expect(expected).not.toContain(".");
    expect(expected.length).toBeGreaterThan(0);
  });

  test("parses x.com and twitter.com status URLs", () => {
    expect(parseTweetId("https://x.com/theo/status/2103034083127501079?s=20")).toBe("2103034083127501079");
    expect(parseTweetId("http://www.twitter.com/theo/status/123")).toBe("123");
    expect(parseTweetId("https://example.com/theo/status/123")).toBeNull();
  });
});

describe("sparse frames", () => {
  test("inherits probabilities across gaps and the final tail", () => {
    const timeline = frameTimeline(15, [0, 3, 12]);
    const probs = inheritProbabilities(timeline, [0, 3, 12], [0.1, 0.9, 0.1]);
    expect(findRuns(probs, 0.5)).toEqual([{ start: 3, end: 11 }]);
    expect(pickSeconds({ start: 3, end: 11 })).toEqual([3, 8, 11]);
    expect([3, 8, 11].map((second) => timeline[second])).toEqual([3, 3, 3]);
    expect(probs.slice(12)).toEqual([0.1, 0.1, 0.1]);
    const [post] = groupPosts([3, 8, 11].map((second) => ({ second, line: { handle: "@theo", displayName: "Theo", text: "same post" } })));
    expect([post.firstSeen, post.lastSeen]).toEqual([3, 11]);
  });
  test("legacy manifests keep every second", () => {
    expect(frameSeconds(4)).toEqual([0, 1, 2, 3]);
    expect(frameTimeline(4)).toEqual([0, 1, 2, 3]);
    expect(inheritProbabilities(frameTimeline(4), frameSeconds(4), [0.1, 0.9, 0.9, 0.1])).toEqual([0.1, 0.9, 0.9, 0.1]);
  });
  test("single static frame spans the whole video", () => {
    expect(inheritProbabilities(frameTimeline(5, [0]), [0], [0.9])).toEqual([0.9, 0.9, 0.9, 0.9, 0.9]);
    expect(frameTimeline(0, [])).toEqual([]);
  });
  test("rejects malformed manifests and missing results", () => {
    for (const seconds of [[1], [0, 0], [0, 2, 1], [0, 4], [0, 1.5]]) expect(() => frameTimeline(4, seconds)).toThrow();
    expect(() => inheritProbabilities([0, 1], [0, 1], [0.1])).toThrow();
  });
});
