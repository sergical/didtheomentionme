import { expect, test } from "bun:test";
import { Schema } from "effect";
import type { LookupInput, LookupResult, Match } from "../src/lookup";
import { Flags, type ExploreData, type PageFlags, type SourceRef } from "../src/ui/model";

/** A seeded random source, so a failing page can be made again from its seed. */
function seeded(seed: number) {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ["", "theo", "Théo – t3.gg 🚀", "日本語のポスト", `<b>"quoted" & 'single'</b>`, "line one\nline two", "x".repeat(300)];

/**
 * The pages the routes make, with random values in them. It does not use the schema, so a field the schema forgets,
 * mistypes or wrongly requires shows up as a difference after the handoff.
 */
function generator(next: () => number) {
  const int = (max = 5000) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const text = () => pick(TEXTS);
  const orNull = <T>(make: () => T) => (next() < 0.3 ? null : make());
  const orUndefined = <T>(make: () => T) => (next() < 0.3 ? undefined : make());
  const list = <T>(make: () => T) => Array.from({ length: int(4) }, make);
  const coverage = () => ({ videos: int(), from: orNull(text), to: orNull(text) });
  const source = (): SourceRef => ({ id: text(), name: text(), avatar: text(), hue: int(360), coverage: coverage() });
  const creator = () => ({ id: text(), name: text() });
  const reading = () => pick(["all", "part", "comment"] as const);

  const match = (): Match => ({
    videoId: text(), title: orNull(text), publishedAt: orNull(text), handle: text(), displayName: orNull(text), text: text(),
    firstSeen: int(), lastSeen: int(), times: list(int), frameUrl: text(), exact: next() < 0.5,
    readAloud: orNull(() => ({ at: int(), quote: text(), reading: reading() })),
  });

  // A handle search sets `tweet` and `tweetError` even when it has neither. A text search scores each match.
  const handleSearch = (): LookupResult => ({
    source: creator(), handle: text(), coverage: coverage(), matches: list(match),
    tweet: orUndefined(() => ({ id: text(), handle: text(), text: text(), createdAt: orNull(text) })), tweetError: orUndefined(text),
  });

  const textSearch = (): LookupResult => ({ source: creator(), handle: null, query: text(), coverage: coverage(), matches: list(() => ({ ...match(), overlap: next() })) });

  // The route fills in every field of a page's input.
  const form = () => ({ kind: "lookup" as const, source: source(), sources: list(source), input: { handle: text(), tweet: text(), q: text(), source: text() } satisfies LookupInput });

  const explore = (): ExploreData => ({
    source: source(), sources: list(source), xHandle: text(), sort: pick(["newest", "posts"] as const),
    totals: { videos: int(), seconds: int(), from: orNull(text), to: orNull(text), shown: int(), aloud: int() },
    accounts: list(() => ({ handleNorm: text(), handle: text(), shown: int(), aloud: int(), videos: int() })),
    position: list(int),
    longReads: list(() => ({ videoId: text(), title: orNull(text), handle: text(), displayName: orNull(text), quote: text(), reading: reading(), readAt: int(), firstSeen: int(), lastSeen: int(), frameSecond: int() })),
    videos: list(() => ({ id: text(), title: orNull(text), publishedAt: orNull(text), duration: orNull(int), shown: int(), aloud: int(), accounts: list(() => ({ handle: text(), shown: int() })) })),
    crossovers: list(() => ({ other: { id: text(), name: text(), xHandle: text() }, showed: int(), shownBy: int() })),
  });

  // The lookup page is the empty form, a result of either search, or an error. The explore page is the other page.
  const pages: (() => PageFlags)[] = [
    form,
    () => ({ ...form(), result: handleSearch() }),
    () => ({ ...form(), result: textSearch() }),
    () => ({ ...form(), error: text() }),
    () => ({ kind: "explore", ...explore() }),
  ];

  return (): PageFlags => pick(pages)();
}

// The handoff Foldkit does with the page data: encode with the schema, write JSON into the page, parse and decode.
const codec = Schema.toCodecJson(Flags);
const throughThePage = (flags: PageFlags) => Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(flags))));

test("any page's data reaches the browser as the Worker sent it", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const page = generator(seeded(seed))();
    expect(throughThePage(page), `seed ${seed}`).toEqual(page);
  }
});
