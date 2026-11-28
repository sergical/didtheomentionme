import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import type { LookupInput } from "../lookup";

export type Tab = "handle" | "post" | "text";

/** The tab of the search a page shows. */
export const tabFor = (input: LookupInput): Tab => (input.q?.trim() ? "text" : input.tweet.trim() && !input.handle.trim() ? "post" : "handle");

// The page data crosses from the Worker to the browser as JSON in the page, so these schemas are its contract. The
// lookup ones repeat the types of `../lookup`, which the browser script cannot import, and the type check keeps the
// two the same: the Worker passes its types in, and the views pass these types to code that takes the Worker's.

const Coverage = Schema.Struct({ videos: Schema.Number, from: Schema.NullOr(Schema.String), to: Schema.NullOr(Schema.String) });

const SourceRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatar: Schema.String,
  /** OKLCH hue of the page accent. */
  hue: Schema.Number,
  coverage: Coverage,
});

export type SourceRef = typeof SourceRef.Type;

const Reading = Schema.Literals(["all", "part", "comment"]);

const Match = Schema.Struct({
  videoId: Schema.String,
  title: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  handle: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  text: Schema.String,
  firstSeen: Schema.Number,
  lastSeen: Schema.Number,
  times: Schema.mutable(Schema.Array(Schema.Number)),
  frameUrl: Schema.String,
  exact: Schema.Boolean,
  readAloud: Schema.NullOr(Schema.Struct({ at: Schema.Number, quote: Schema.String, reading: Reading })),
  overlap: Schema.optional(Schema.Number),
});

const Result = Schema.Struct({
  source: Schema.Struct({ id: Schema.String, name: Schema.String }),
  handle: Schema.NullOr(Schema.String),
  query: Schema.optional(Schema.String),
  coverage: Coverage,
  tweet: Schema.optional(Schema.Struct({ id: Schema.String, handle: Schema.String, text: Schema.String, createdAt: Schema.NullOr(Schema.String) })),
  tweetError: Schema.optional(Schema.String),
  matches: Schema.mutable(Schema.Array(Match)),
});

/** The lookup page: the search form, and the result or the error of a search. */
const PageData = Schema.Struct({
  source: SourceRef,
  sources: Schema.mutable(Schema.Array(SourceRef)),
  input: Schema.Struct({ handle: Schema.String, tweet: Schema.String, q: Schema.optional(Schema.String), source: Schema.optional(Schema.String) }),
  result: Schema.optional(Result),
  error: Schema.optional(Schema.String),
});

export type PageData = typeof PageData.Type;

const ExploreSort = Schema.Literals(["newest", "posts"]);

export type ExploreSort = typeof ExploreSort.Type;

const LongRead = Schema.Struct({
  videoId: Schema.String,
  title: Schema.NullOr(Schema.String),
  handle: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  quote: Schema.String,
  reading: Reading,
  readAt: Schema.Number,
  firstSeen: Schema.Number,
  lastSeen: Schema.Number,
  frameSecond: Schema.Number,
});

export type LongRead = typeof LongRead.Type;

/** The explore page: what one creator showed across every scanned video. */
const ExploreData = Schema.Struct({
  source: SourceRef,
  sources: Schema.mutable(Schema.Array(SourceRef)),
  xHandle: Schema.String,
  sort: ExploreSort,
  totals: Schema.Struct({ videos: Schema.Number, seconds: Schema.Number, from: Schema.NullOr(Schema.String), to: Schema.NullOr(Schema.String), shown: Schema.Number, aloud: Schema.Number }),
  accounts: Schema.mutable(Schema.Array(Schema.Struct({ handleNorm: Schema.String, handle: Schema.String, shown: Schema.Number, aloud: Schema.Number, videos: Schema.Number }))),
  /** Posts first seen in each tenth of a video, from the start. */
  position: Schema.mutable(Schema.Array(Schema.Number)),
  longReads: Schema.mutable(Schema.Array(LongRead)),
  videos: Schema.mutable(Schema.Array(Schema.Struct({
    id: Schema.String,
    title: Schema.NullOr(Schema.String),
    publishedAt: Schema.NullOr(Schema.String),
    duration: Schema.NullOr(Schema.Number),
    shown: Schema.Number,
    aloud: Schema.Number,
    accounts: Schema.mutable(Schema.Array(Schema.Struct({ handle: Schema.String, shown: Schema.Number }))),
  }))),
  crossovers: Schema.mutable(Schema.Array(Schema.Struct({ other: Schema.Struct({ id: Schema.String, name: Schema.String, xHandle: Schema.String }), showed: Schema.Number, shownBy: Schema.Number }))),
});

export type ExploreData = typeof ExploreData.Type;

/** What the server hands the browser: the page's data, as JSON in the page. */
export const Flags = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("lookup"), ...PageData.fields }),
  Schema.Struct({ kind: Schema.Literal("explore"), ...ExploreData.fields }),
]);

export type PageFlags = typeof Flags.Type;

const Button = Schema.Literals(["share", "copy"]);

export type Button = typeof Button.Type;

export const Model = Schema.Struct({
  page: Flags,
  tab: Schema.Literals(["handle", "post", "text"]),
  /** A search form was sent, and the next page has not shown yet. */
  busy: Schema.Boolean,
  /** For each button, the copy whose "✓ Copied" it shows, or 0. Each button resets on its own timer. */
  copied: Schema.Struct({ share: Schema.Number, copy: Schema.Number }),
  /** Counts copies, so that a reset clears only the label of its own copy. */
  copies: Schema.Number,
  status: Schema.String,
  /** The status is on screen, not only read by screen readers, when the browser could not copy. */
  statusVisible: Schema.Boolean,
  /** On a phone with a share sheet, "Share result" does it all, so "Copy link" hides. */
  hideCopy: Schema.Boolean,
});

export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ChangedTab: { tab: Schema.Literals(["handle", "post", "text"]) },
  ClickedTabLabel: { tab: Schema.Literals(["handle", "post", "text"]) },
  ClickedSwitchTab: { tab: Schema.Literals(["handle", "post", "text"]) },
  ClickedShare: { url: Schema.String, title: Schema.String },
  ClickedCopy: { url: Schema.String },
  CopiedLink: { button: Button },
  FailedCopy: { url: Schema.String },
  ResetCopy: { button: Button, copy: Schema.Number },
  Shared: {},
  Focused: {},
  SubmittedSearch: {},
  ShowedPage: {},
  DetectedSharing: { hideCopy: Schema.Boolean },
});

export type Message = typeof Message.Type;
