import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import type { LookupInput, LookupResult, Reading } from "../lookup";

export type Tab = "handle" | "post" | "text";

/** The tab of the search a page shows. */
export const tabFor = (input: LookupInput): Tab => (input.q?.trim() ? "text" : input.tweet.trim() && !input.handle.trim() ? "post" : "handle");

export interface SourceRef {
  id: string;
  name: string;
  avatar: string;
  /** OKLCH hue of the page accent. */
  hue: number;
  coverage: LookupResult["coverage"];
}

/** The lookup page: the search form, and the result or the error of a search. */
export interface PageData {
  source: SourceRef;
  sources: SourceRef[];
  input: LookupInput;
  result?: LookupResult;
  error?: string;
}

export type ExploreSort = "newest" | "posts";

export interface LongRead {
  videoId: string;
  title: string | null;
  handle: string;
  displayName: string | null;
  quote: string;
  reading: Reading;
  readAt: number;
  firstSeen: number;
  lastSeen: number;
  frameSecond: number;
}

/** The explore page: what one creator showed across every scanned video. */
export interface ExploreData {
  source: SourceRef;
  sources: SourceRef[];
  xHandle: string;
  sort: ExploreSort;
  totals: { videos: number; seconds: number; from: string | null; to: string | null; shown: number; aloud: number };
  accounts: { handleNorm: string; handle: string; shown: number; aloud: number; videos: number }[];
  /** Posts first seen in each tenth of a video, from the start. */
  position: number[];
  longReads: LongRead[];
  videos: { id: string; title: string | null; publishedAt: string | null; duration: number | null; shown: number; aloud: number; accounts: { handle: string; shown: number }[] }[];
  crossovers: { other: { id: string; name: string; xHandle: string }; showed: number; shownBy: number }[];
}

/** What the server hands the browser: the page's data, as JSON in the page. */
export type PageFlags = ({ kind: "lookup" } & PageData) | ({ kind: "explore" } & ExploreData);

// The page data comes from our own server in the same deploy, so the browser takes it as it is.
const PageFlagsSchema = Schema.Unknown as unknown as Schema.Codec<PageFlags, PageFlags>;
export const Flags = PageFlagsSchema;

const Button = Schema.Literals(["share", "copy"]);
export type Button = typeof Button.Type;

export const Model = Schema.Struct({
  page: PageFlagsSchema,
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
