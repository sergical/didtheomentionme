import { describe, expect, test } from "bun:test";
import {
  buildWindow,
  canonicalHandles,
  countHandles,
  frameSeconds,
  frameTimeline,
  inheritProbabilities,
  expandSentence,
  findRuns,
  formatTime,
  groupPosts,
  jaccard,
  normalizeHandle,
  overlap,
  parseReaderLines,
  pickSeconds,
  quoteSpan,
  sameHandle,
  timeAtOffset,
  withCanonicalHandle,
  wordRunSpan,
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
  test("a line with only question marks has no post text", () => {
    expect(parseReaderLines("@patloeber | Patrick | ? ? ? ?")).toEqual([]);
  });

  test("keeps a valid line", () => {
    expect(parseReaderLines("@ThePrimeagen | ThePrimeagen | tested out Haiku vs Luna")).toEqual([
      { handle: "@ThePrimeagen", displayName: "ThePrimeagen", text: "tested out Haiku vs Luna" },
    ]);
  });

  test("rejects Live on X panel lines", () => {
    const output = [
      "@Esfand | Esfand is hosting | BIG CORN BEGGING WOCO",
      "@giri | giri | is hosting I cant believe IM A VTUBER",
      "@teej_dv | teej dv | is hosting",
    ].join("\n");

    expect(parseReaderLines(output)).toEqual([]);
  });

  test("keeps a post that uses the word hosting", () => {
    for (const text of ["Cloudflare is hosting our app and hosting is hard", "Is hosting on Cloudflare free?"]) {
      expect(parseReaderLines(`@KentonVarda | Kenton Varda | ${text}`)).toEqual([{ handle: "@KentonVarda", displayName: "Kenton Varda", text }]);
    }
  });

  test("rejects handles with dots", () => {
    expect(parseReaderLines("@t3.gg | Theo | some text here")).toEqual([]);
  });

  test("rejects handles longer than 15 characters and short text", () => {
    const output = ["@abcdefghijklmnop | Name | long handle text", "@theo | Theo | ?"].join("\n");
    expect(parseReaderLines(output)).toEqual([]);
  });

  test("keeps pipes inside the post text and ignores prose lines", () => {
    const output = "Here are the posts:\n@theo | Theo | a | b | c";
    expect(parseReaderLines(output)).toEqual([{ handle: "@theo", displayName: "Theo", text: "a | b | c" }]);
  });

  test("joins a post written over several lines", () => {
    expect(parseReaderLines("@a | A | first line\n\nsecond line\n@b | B | another post")).toEqual([
      { handle: "@a", displayName: "A", text: "first line second line" },
      { handle: "@b", displayName: "B", text: "another post" },
    ]);
  });

  test("a post can hold the column separator on a later line", () => {
    expect(parseReaderLines("@a | A | Supported commands:\nread | write | execute")).toEqual([
      { handle: "@a", displayName: "A", text: "Supported commands: read | write | execute" },
    ]);
  });

  test("NONE is no posts", () => {
    expect(parseReaderLines("NONE")).toEqual([]);
  });

  const LONG_POST = "a real post that is long enough to find with a text search later";

  test("marks an unreadable handle as unknown and keeps the post", () => {
    for (const handle of ["@unknown", "?", "@ma?ia", "@chasmmm…", "@chasmmm...", "@Pipkin Pippa", ""]) {
      expect(parseReaderLines(`${handle} | Name | ${LONG_POST}`)).toEqual([{ handle: "@unknown", displayName: "Name", text: LONG_POST }]);
    }
  });

  test("drops a short line with no handle, such as a tab title or a stream card", () => {
    expect(parseReaderLines('@unknown | | (21) Addy Osmani on X: "How th\n@unknown | Esfand | <Crusade> Alliance - PvP - WoW: Forever ...')).toEqual([]);
    expect(parseReaderLines("@theo | Theo | ok then")).toEqual([{ handle: "@theo", displayName: "Theo", text: "ok then" }]);
  });

  test("clears the page heading used as a display name", () => {
    expect(parseReaderLines(`@unknown | Post | ${LONG_POST}`)).toEqual([{ handle: "@unknown", displayName: "", text: LONG_POST }]);
  });

  test("drops a handle that X does not allow", () => {
    expect(parseReaderLines("@maria.rcks | Maria | a post on another site\n@viktoriamarkovska4236 | V | a comment")).toEqual([]);
  });
});

describe("jaccard", () => {
  test("identical texts score 1, disjoint texts 0", () => {
    expect(jaccard("Haiku is fast", "haiku IS fast")).toBe(1);
    expect(jaccard("one two", "three four")).toBe(0);
  });
});

describe("normalizeHandle", () => {
  test("an unknown handle is empty, so a search cannot match it", () => {
    expect(normalizeHandle("@unknown")).toBe("");
    expect(normalizeHandle("@ThePrimeagen")).toBe("theprimeagen");
  });
});

describe("canonicalHandles", () => {
  const seen = (handle: string, displayName: string, count: number) => ({ handle, names: new Set(displayName ? [displayName] : []), count });

  test("maps misreads to the spelling the same name has far more often", () => {
    const canonical = canonicalHandles([seen("@thsottiaux", "Tibo", 17), seen("@thsoittiaux", "Tibo", 2), seen("@thnsottiaux", "Tibo", 1)]);
    expect(Object.fromEntries(canonical)).toEqual({ "@thsoittiaux": "@thsottiaux", "@thnsottiaux": "@thsottiaux" });
  });

  test("keeps near handles with different names apart", () => {
    expect(canonicalHandles([seen("@opencode", "OpenCode", 14), seen("@odincode", "Mikey", 1)]).size).toBe(0);
  });

  test("keeps spellings that are about as common", () => {
    expect(canonicalHandles([seen("@lisabey", "Lisa", 3), seen("@lisabeyy", "Lisa", 2)]).size).toBe(0);
  });

  test("ignores an empty display name", () => {
    expect(canonicalHandles([seen("@thsottiaux", "", 17), seen("@thsoittiaux", "", 1)]).size).toBe(0);
  });

  test("a chain of misreads ends at the top spelling", () => {
    const canonical = canonicalHandles([seen("@abcdefgh", "A", 8), seen("@abcdefgx", "A", 3), seen("@abcdefyx", "A", 1)]);
    expect(canonical.get("@abcdefyx")).toBe("@abcdefgh");
  });

  test("withCanonicalHandle ignores case and leaves other handles alone", () => {
    const canonical = new Map([["@thsoittiaux", "@thsottiaux"]]);
    expect(withCanonicalHandle({ handle: "@THSoittiaux", n: 1 }, canonical)).toEqual({ handle: "@thsottiaux", n: 1 });
    expect(withCanonicalHandle({ handle: "@theo", n: 1 }, canonical)).toEqual({ handle: "@theo", n: 1 });
  });

  test("countHandles counts one handle across spellings and names, without unknown", () => {
    const rows = [
      { handle: "@LisaBey", displayName: "Lisa" },
      { handle: "@LisaBey", displayName: "Lisa B." },
      { handle: "@lisabey", displayName: "" },
      { handle: "@unknown", displayName: "A" },
    ];

    expect(countHandles(rows)).toEqual([{ handle: "@LisaBey", names: new Set(["Lisa", "Lisa B."]), count: 3 }]);
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

describe("quoteSpan", () => {
  const text = "Back in May we did a promotion";

  test("keeps a span of three or more words", () => {
    expect(quoteSpan([0, 11], text)).toEqual([0, 11]);
  });

  test("rejects a lone name", () => {
    expect(quoteSpan([8, 11], text)).toBeNull();
  });

  test("does not count punctuation as words", () => {
    expect(quoteSpan([0, 7], "— Jev —")).toBeNull();
  });
});

describe("wordRunSpan", () => {
  const transcript = "So GPT 62 Astra has made an appearance on Google Cloud today";

  test("finds three post words in a row, ignoring case and punctuation", () => {
    const [start, end] = wordRunSpan("GPT 6.2 Astra HAS made an appearance!", transcript)!;
    expect(transcript.slice(start, end)).toBe("Astra has made");
  });

  test("finds a post of exactly three words", () => {
    const [start, end] = wordRunSpan("Dario is right", "plus Elon saying Dario is right yeah")!;
    expect("plus Elon saying Dario is right yeah".slice(start, end)).toBe("Dario is right");
  });

  test("matches a curly apostrophe in the post to a straight one in the transcript", () => {
    expect(wordRunSpan("It’s very good", "It's very good")).toEqual([0, 9]);
  });

  test("returns null when words are not in a row or the post is too short", () => {
    expect(wordRunSpan("Astra has never made", transcript)).toBeNull();
    expect(wordRunSpan("Astra has", transcript)).toBeNull();
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
