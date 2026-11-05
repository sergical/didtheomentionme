// Pure functions of the video pipeline. No bindings, so they run under `bun test`.

export interface Run {
  start: number;
  end: number;
}

/** Joins seconds with p >= threshold into runs; two hits at most `maxGap` seconds apart share a run. */
export function findRuns(probs: number[], threshold: number, maxGap = 3): Run[] {
  const runs: Run[] = [];
  probs.forEach((p, second) => {
    if (p < threshold) return;
    const last = runs.at(-1);
    if (last && second - last.end <= maxGap) last.end = second;
    else runs.push({ start: second, end: second });
  });
  return runs;
}

/** Every `every` seconds from the run start, plus the run end. */
export function pickSeconds(run: Run, every = 5): number[] {
  const picks: number[] = [];
  for (let t = run.start; t < run.end; t += every) picks.push(t);
  picks.push(run.end);
  return picks;
}

export interface ReaderLine {
  handle: string;
  displayName: string;
  text: string;
}

const HANDLE = /^@[A-Za-z0-9_]{1,15}$/;
/** The reader copies the `@handle | display name` placeholders from its prompt when it cannot read the name. */
export const UNKNOWN_HANDLE = "@unknown";
const PLACEHOLDER_HANDLES = new Set(["@handle", "@unknown", "@username", "@user"]);
const PLACEHOLDER_NAMES = new Set(["display name", "?", "unknown"]);

/** Parses the reader model output, one `@handle | display name | text` per line. Drops malformed lines. */
export function parseReaderLines(output: string): ReaderLine[] {
  const lines: ReaderLine[] = [];
  for (const raw of output.split("\n")) {
    const parts = raw.replace(/^\s*[-*•]\s*/, "").split("|");
    if (parts.length < 3) continue;
    const handle = parts[0].trim();
    const displayName = parts[1].trim();
    const text = parts.slice(2).join("|").trim();
    if (!HANDLE.test(handle) || text.length < 3 || tokenize(text).length === 0) continue;
    lines.push({
      handle: PLACEHOLDER_HANDLES.has(handle.toLowerCase()) ? UNKNOWN_HANDLE : handle,
      displayName: PLACEHOLDER_NAMES.has(displayName.toLowerCase()) ? "" : displayName,
      text,
    });
  }
  return lines;
}

export const tokenize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function jaccard(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const token of x) if (y.has(token)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Share of `queryTokens` that appear in `text`. */
export function overlap(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const have = new Set(tokenize(text));
  return queryTokens.filter((t) => have.has(t)).length / queryTokens.length;
}

const SAME_POST_CONTAINMENT = 0.8;

/** One reading can be a slice of the other, so this compares the shorter text's words against the longer. */
export function samePost(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return overlap([...new Set(tokenize(short))], long) >= SAME_POST_CONTAINMENT;
}

export interface Observation {
  second: number;
  line: ReaderLine;
}

export interface PostGroup {
  handle: string;
  displayName: string;
  /** Every distinct slice of text read for this handle in the run, one per line. */
  text: string;
  /** The same slices, longest first. A screenshot inside the post can be longer than the post itself. */
  slices: string[];
  firstSeen: number;
  lastSeen: number;
  /** Second of the 1280 px frame where the post was first read. */
  frameSecond: number;
}

const JACCARD_SAME_POST = 0.6;

const SAME_TEXT_MIN_CHARS = 40;

/** For two lines under different handles. A short text can match another post's text by chance. */
export const sameLongPost = (a: string, b: string) => Math.min(a.length, b.length) >= SAME_TEXT_MIN_CHARS && samePost(a, b);

function mostCommon(counts: Map<string, number>): string {
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** Edit distance, for telling a misread handle from a different one. */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The reader drops or swaps a few characters of long handles (lydhahallie, gautamgoel for gautamgoel978). */
export function sameHandle(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 8 && (a.startsWith(b) || b.startsWith(a))) return true;
  return shorter >= 6 && levenshtein(a, b) <= 2;
}

/**
 * Groups reader lines of one run into one post group per handle. Frames 5 s apart show different
 * slices of a scrolled post or thread, so the group keeps each distinct slice of text.
 * A line whose handle matches no group joins the group with the same post text, because the reader
 * sometimes writes the display name or a placeholder when the handle is out of frame.
 */
export function groupPosts(observations: Observation[]): PostGroup[] {
  interface Acc extends Omit<PostGroup, "text" | "slices"> {
    handles: Map<string, number>;
    names: Map<string, number>;
    texts: string[];
  }
  const groups: Acc[] = [];
  for (const { second, line } of [...observations].sort((a, b) => a.second - b.second)) {
    const norm = line.handle.toLowerCase();
    const known = line.handle !== UNKNOWN_HANDLE;
    let group = (known ? groups.find((g) => [...g.handles.keys()].some((h) => sameHandle(h.toLowerCase(), norm))) : undefined)
      ?? groups.find((g) => g.texts.some((t) => sameLongPost(t, line.text)));
    if (!group) {
      group = {
        handles: new Map(),
        names: new Map(),
        texts: [],
        handle: line.handle,
        displayName: line.displayName,
        firstSeen: second,
        lastSeen: second,
        frameSecond: second,
      };
      groups.push(group);
    }
    if (known) bump(group.handles, line.handle);
    if (line.displayName) bump(group.names, line.displayName);
    const same = group.texts.findIndex((t) => t === line.text || jaccard(t, line.text) >= JACCARD_SAME_POST);
    if (same < 0) group.texts.push(line.text);
    else if (line.text.length > group.texts[same].length) group.texts[same] = line.text;
    group.lastSeen = Math.max(group.lastSeen, second);
    group.handle = mostCommon(group.handles) || UNKNOWN_HANDLE;
    group.displayName = mostCommon(group.names);
  }
  return groups.map(({ handle, displayName, texts, firstSeen, lastSeen, frameSecond }) => ({
    handle,
    displayName,
    text: texts.join("\n"),
    slices: [...texts].sort((a, b) => b.length - a.length),
    firstSeen,
    lastSeen,
    frameSecond,
  }));
}

/** [seconds, word] */
export type Word = [number, string];

export interface TranscriptWindow {
  text: string;
  /** [character offset of the word in `text`, second the word starts] */
  offsets: [number, number][];
}

const CAPTION_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** YouTube captions escape HTML and mark a speaker change with a bare ">>". */
export function decodeCaption(word: string): string {
  const decoded = word.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => CAPTION_ENTITIES[e]).trim();
  return decoded === ">>" ? "" : decoded;
}

export function buildWindow(words: Word[], from: number, to: number): TranscriptWindow {
  let text = "";
  const offsets: [number, number][] = [];
  for (const [second, raw] of words) {
    if (second < from || second > to) continue;
    const word = decodeCaption(raw);
    if (!word) continue;
    offsets.push([text.length ? text.length + 1 : 0, second]);
    text += (text ? " " : "") + word;
  }
  return { text, offsets };
}

/** The start time of the last word whose offset is at or before `char`. */
export function timeAtOffset(offsets: [number, number][], char: number): number | undefined {
  return (offsets.findLast(([offset]) => offset <= char) ?? offsets[0])?.[1];
}

const isTerminator = (c: string | undefined) => c === "." || c === "?" || c === "!";

/**
 * The sentence around a span: expands both ways to the next `.`, `?` or `!`, or `maxExtra` characters.
 * Caption text has no punctuation, so the character cap is what usually applies.
 */
export function expandSentence(text: string, spanStart: number, spanEnd: number, maxExtra = 120): string {
  const lo = Math.max(0, spanStart - maxExtra);
  let start = spanStart;
  while (start > lo && !isTerminator(text[start - 1])) start--;
  if (start === lo && lo > 0 && !isTerminator(text[start - 1]) && text[start - 1] !== " ") {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < spanStart) start = space + 1;
  }

  const hi = Math.min(text.length, spanEnd + maxExtra);
  let end = spanEnd;
  while (end < hi && !isTerminator(text[end - 1])) end++;
  if (end === hi && hi < text.length && !isTerminator(text[end - 1]) && text[end] !== " ") {
    const space = text.lastIndexOf(" ", end);
    if (space > spanEnd) end = space;
  }
  return text.slice(start, end).trim();
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number; end: number }[];
}

/** Word timings from a Whisper result; segments without word data get evenly spread words. */
export function wordsFromSegments(segments: WhisperSegment[], offsetSeconds: number): Word[] {
  const words: Word[] = [];
  for (const segment of segments) {
    if (segment.words?.length) {
      for (const w of segment.words) {
        const word = w.word.trim();
        if (word) words.push([offsetSeconds + w.start, word]);
      }
      continue;
    }
    const tokens = segment.text.split(/\s+/).filter(Boolean);
    const step = tokens.length ? (segment.end - segment.start) / tokens.length : 0;
    tokens.forEach((word, i) => words.push([offsetSeconds + segment.start + i * step, word]));
  }
  return words;
}

/** Old manifests have a frame for every second. */
export function frameSeconds(frames: number, keptSeconds?: number[]): number[] {
  return keptSeconds ?? Array.from({ length: frames }, (_, second) => second);
}

/** Maps each video second to the previous stored frame. */
export function frameTimeline(frames: number, keptSeconds?: number[]): number[] {
  const seconds = frameSeconds(frames, keptSeconds);
  if (frames > 0 && seconds[0] !== 0) throw new Error("first frame must be second zero");
  for (let i = 0; i < seconds.length; i++) {
    if (!Number.isInteger(seconds[i]) || seconds[i] < 0 || seconds[i] >= frames || (i > 0 && seconds[i] <= seconds[i - 1])) {
      throw new Error("invalid kept frame seconds");
    }
  }
  let index = 0;
  return Array.from({ length: frames }, (_, second) => {
    while (index + 1 < seconds.length && seconds[index + 1] <= second) index++;
    return seconds[index];
  });
}

/** Skipped seconds inherit the previous kept probability, including the final tail. */
export function inheritProbabilities(timeline: number[], seconds: number[], probabilities: number[]): number[] {
  const bySecond = new Map(seconds.map((second, i) => [second, probabilities[i]]));
  return timeline.map((second) => {
    const probability = bySecond.get(second);
    if (probability === undefined) throw new Error(`missing probability for frame ${second}`);
    return probability;
  });
}
