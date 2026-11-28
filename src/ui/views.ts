/**
 * The two pages as Foldkit views. The server renders them to HTML, and the browser hydrates the same views, so these
 * functions must stay pure: no `document`, `window` or `navigator`.
 */
import type { Attribute } from "foldkit/html";
import type { LookupResult, Match } from "../lookup";
import { UNKNOWN_HANDLE, formatTime } from "../pipeline";
import { explorePath, resultPath, shareTitle, SITE_ORIGIN } from "../share";
import { PageBehaviors } from "./behaviors";
import { exploreView } from "./explore-view";
import { Message, tabFor, type Model, type PageFlags, type Tab } from "./model";
import { PLAY, at, creatorPicker, icon, saidFigure, youtube, type Child, type H, type Node } from "./parts";
import { formatDate, plural } from "./text";

const WORDS = /[\p{L}\p{N}]+/gu;

/** A text match with at least this share of the query words is shown as a close match. */
const CLOSE_MATCH = 0.75;
const SHOWN = 10;

/** The words of `text` that are in `words`, marked. */
function highlight(h: H, text: string, words: Set<string>): Child[] {
  if (words.size === 0) return [text];
  const out: Child[] = [];
  let last = 0;

  for (const m of text.matchAll(WORDS)) {
    const before = text.slice(last, m.index);

    if (before) out.push(before);
    out.push(words.has(m[0].toLowerCase()) ? h.mark([], [m[0]]) : m[0]);
    last = m.index + m[0].length;
  }

  const rest = text.slice(last);

  if (rest) out.push(rest);

  return out;
}

/** Starts long text a few words before the first word in `words`, so the clamped excerpt shows the match. */
function fromFirstHit(text: string, words: Set<string>): string {
  const hit = [...text.matchAll(WORDS)].find((m) => words.has(m[0].toLowerCase()));

  if (!hit || hit.index < 60) return text;
  const space = text.indexOf(" ", hit.index - 40);

  return `…${text.slice(space === -1 || space >= hit.index ? hit.index : space + 1)}`;
}

const switchTab = (h: H, tab: Tab, label: string) => h.button([h.Type("button"), h.Class("switch"), h.OnClick(Message.ClickedSwitchTab({ tab }))], [label]);

/** What the creator did with the posts they showed: read them, talked about them, or neither. */
function saidClause(close: Match[]): string {
  const read = close.filter((m) => m.readAloud && m.readAloud.reading !== "comment").length;
  const talked = close.filter((m) => m.readAloud?.reading === "comment").length;
  const one = close.length === 1;
  const count = (n: number) => (n < close.length ? String(n) : one ? "it" : close.length === 2 ? "both" : "every one");
  const readCount = one && close[0].readAloud?.reading === "part" ? "part of it" : count(read);
  const notRead = `but did not read ${one ? "it" : "them"} aloud.`;

  if (read && talked) return `, read ${readCount} aloud and talked about ${count(talked)}.`;

  if (read) return ` and read ${readCount} aloud.`;

  return talked ? ` and talked about ${count(talked)}, ${notRead}` : `, ${notRead}`;
}

/** The headline of a result: whether the creator showed the post, and one line of detail. */
interface Verdict {
  kind: "yes" | "maybe" | "no";
  answer: string;
  detail: Child[];
}

/** The answer when no post is a close match, and what to try next. */
function noMatch(h: H, result: LookupResult, loose: Match[]): Verdict {
  const { videos, from, to } = result.coverage;

  if (loose.length) return { kind: "maybe", answer: "Not exactly.", detail: [`No post has most of these words. ${plural(loose.length, "post")} ${loose.length === 1 ? "has" : "have"} some of them.`] };

  if (videos === 0) return { kind: "no", answer: "Not yet.", detail: [`No ${result.source.name} videos are indexed yet.`] };

  const next: Child[] = result.query
    ? ["Try other words, or ", switchTab(h, "handle", "search by handle"), "."]
    : ["Handle cropped out of the screenshot? ", switchTab(h, "text", "Search by words from the post"), "."];

  return { kind: "no", answer: "Not yet.", detail: [`Nothing in the ${plural(videos, "video")} from ${formatDate(from, false)} to ${formatDate(to)}. `, ...next] };
}

function verdict(h: H, result: LookupResult, close: Match[], loose: Match[]): Node {
  const { name } = result.source;
  const about = result.query ? `“${result.query}”` : `@${result.handle}`;
  const shown = result.query ? `${name} showed ${plural(close.length, "post")} with that text` : `${name} showed ${close.length === 1 ? "your post" : `${close.length} of your posts`}`;
  const yes = (): Verdict => ({ kind: "yes", answer: "Yes.", detail: [shown + saidClause(close)] });
  const { kind, answer, detail } = close.length ? yes() : noMatch(h, result, loose);

  return h.section([h.Class(`verdict ${kind}`)], [h.p([h.Class("about")], [about]), h.h2([], [answer]), h.p([], detail)]);
}

/** What every card of one list of matches shares. */
interface MatchList {
  /** The words of a text search, to highlight. */
  words: Set<string>;
  sourceName: string;
  showText: boolean;
  /** The first cards of the list load their frames at once. */
  eager: boolean;
}

function card(h: H, m: Match, i: number, { words, sourceName, showText, eager }: MatchList): Node {
  const { newTab } = at(h);

  const seen = m.times.map((t, n) =>
    h.a([h.Class("chip"), ...newTab, h.Href(youtube(m.videoId, t))], [...(n === 0 ? [icon(h, PLAY)] : []), h.span([h.Class("sr-only")], ["On screen at "]), formatTime(t)]));

  const said = m.readAloud ? saidFigure(h, sourceName, m.videoId, m.readAloud) : h.p([h.Class("quiet")], ["Not read aloud."]);
  const who = showText ? [] : [`Post by ${m.handle === UNKNOWN_HANDLE ? "an unknown account" : m.handle}: `];

  return h.li([h.Class("match"), h.Id(`mention-${m.videoId}-${m.firstSeen}`), h.Attribute("style", `--i:${i}`)], [
    h.a([h.Class("frame"), ...newTab, h.Href(youtube(m.videoId, m.firstSeen)), h.Tabindex(-1), h.AriaHidden(true)], [
      h.img([h.Src(m.frameUrl), h.Alt(""), h.Loading(eager && i < 2 ? "eager" : "lazy"), h.Decoding("async")]),
    ]),
    h.div([h.Class("body")], [
      h.div([h.Class("video")], [
        h.a([...newTab, h.Href(youtube(m.videoId, m.firstSeen))], [m.title ?? m.videoId]),
        h.time([h.Attribute("datetime", m.publishedAt ?? "")], [formatDate(m.publishedAt)]),
      ]),
      h.p([h.Class(`excerpt${showText ? "" : " sr-only"}`)], [...who, ...highlight(h, fromFirstHit(m.text, words), words)]),
      said,
      h.p([h.Class("times")], [h.span([], ["On screen"]), ...seen, ...(m.exact ? [h.span([h.Class("badge")], ["Your post"])] : [])]),
    ]),
  ]);
}

const more = (h: H, summary: string, body: Node, open = false) =>
  h.details([h.Class("more"), ...(open ? [h.Open(true)] : [])], [h.summary([], [summary]), body]);

/** The result's own URL, and the sentence that goes with it. */
interface Share {
  url: string;
  title: string;
}

function shareControls(h: H, model: Model, { url, title }: Share): Node {
  const intent = `https://x.com/intent/post?${new URLSearchParams({ text: `${title} Found the receipts.`, url })}`;
  const copied = (button: "share" | "copy", label: string) => (model.copied[button] ? "✓ Copied" : label);

  return h.div([h.Class("share")], [
    h.button([h.Type("button"), h.Class("share-primary"), h.Attribute("data-share", ""), h.OnClick(Message.ClickedShare({ url, title }))], [copied("share", "Share result")]),
    h.button([h.Type("button"), h.Attribute("data-copy", ""), h.Hidden(model.hideCopy), h.OnClick(Message.ClickedCopy({ url }))], [copied("copy", "Copy link")]),
    h.a([h.Href(intent), ...at(h).newTab], ["Post on X ↗"]),
    h.span([h.Class(`share-status${model.statusVisible ? "" : " sr-only"}`), h.Role("status"), h.AriaLive("polite")], [model.status]),
  ]);
}

function results(h: H, model: Model, result: LookupResult, share: Share): Child[] {
  const words = new Set(result.query ? result.query.toLowerCase().match(WORDS) : []);
  const isClose = (m: Match) => !result.query || (m.overlap ?? 0) >= CLOSE_MATCH;
  const close = result.matches.filter(isClose);
  const loose = result.matches.filter((m) => !isClose(m));

  const cards = (list: Match[], eager = false) =>
    h.ol([h.Class("matches")], list.map((m, i) => card(h, m, i, { words, sourceName: result.source.name, showText: Boolean(result.query || result.tweet), eager })));

  return [
    verdict(h, result, close, loose),
    shareControls(h, model, share),
    ...(result.tweet ? [h.p([h.Class("notice")], [`Searched for the post by @${result.tweet.handle}: “${result.tweet.text}”`])] : []),
    ...(result.tweetError ? [h.p([h.Class("notice")], [result.tweetError])] : []),
    ...(close.length ? [cards(close.slice(0, SHOWN), true)] : []),
    ...(close.length > SHOWN ? [more(h, `Show ${close.length - SHOWN} more`, cards(close.slice(SHOWN)))] : []),
    ...(loose.length ? [more(h, `${plural(loose.length, "post")} with some of these words`, cards(loose, close.length === 0), close.length === 0)] : []),
  ];
}

interface Entry {
  id: Tab;
  label: string;
  hint: string;
  prefix?: boolean;
  input: (h: H) => Attribute<Message>[];
}

// An input's text is its `value` attribute, not the live property, so a render never replaces what someone typed.
const ENTRIES = (input: { handle: string; tweet: string; q?: string }): Entry[] => [
  {
    id: "handle",
    label: "X handle",
    hint: "Every post with your handle on screen. A profile or post link works too.",
    prefix: true,
    input: (h) => [h.Name("handle"), h.Attribute("value", input.handle.replace(/^@/, "")), h.Placeholder("yourhandle"), h.Attribute("autocapitalize", "off"), h.Spellcheck(false), h.Required(true)],
  },
  {
    id: "post",
    label: "Post URL",
    hint: "Matches the text of one post, even if the handle was cropped out.",
    input: (h) => [h.Name("tweet"), h.Attribute("value", input.tweet), h.Placeholder("https://x.com/you/status/…"), h.InputMode("url"), h.Spellcheck(false), h.Required(true)],
  },
  {
    id: "text",
    label: "Words from the post",
    hint: "A few words you remember. Matches by words and by meaning.",
    input: (h) => [h.Name("q"), h.Attribute("value", input.q ?? ""), h.Placeholder("haiku vs luna reasoning"), h.Required(true), h.Pattern("\\s*\\S+\\s+\\S.*"), h.Title("Enter at least two words.")],
  },
];

/** The field box with every tab's input. A lookup error replaces the hint of the searched tab, next to the field it is about. */
function field(h: H, sourceId: string, input: { handle: string; tweet: string; q?: string }, error: string | undefined): Node {
  const entries = ENTRIES(input);
  const searched = tabFor(input);
  const errorFor = (id: Tab) => (id === searched ? error : undefined);

  return h.div([], [
    ...entries.map(({ id }) => h.form([h.Id(`f-${id}`), h.Method("get"), h.Action("/")], [h.input([h.Type("hidden"), h.Name("source"), h.Value(sourceId)])])),
    h.div([h.Class("field")], [
      h.span([h.Class("entries")], entries.map((e) =>
        h.span([h.Class(`entry entry-${e.id}`)], [
          h.label([h.Class("sr-only"), h.For(e.id)], [e.label]),
          ...(e.prefix ? [h.span([h.Class("prefix"), h.AriaHidden(true)], ["@"])] : []),
          h.input([h.Id(e.id), h.Attribute("form", `f-${e.id}`), ...e.input(h), h.Attribute("autocomplete", "off"), h.Attribute("aria-describedby", `${e.id}-hint`),
            ...(errorFor(e.id) ? [h.AriaInvalid(true)] : [])]),
        ]))),
      ...entries.map(({ id }) =>
        h.button([h.Class(`go go-${id}`), h.Type("submit"), h.Attribute("form", `f-${id}`)], [h.span([h.Class("label")], ["Check"]), h.span([h.Class("spinner"), h.AriaHidden(true)], [])])),
    ]),
    h.div([h.Class("hints")], entries.map(({ id, hint }) => {
      const e = errorFor(id);

      return h.p([h.Class(`hint hint-${id}${e ? " error" : ""}`), h.Id(`${id}-hint`), ...(e ? [h.Role("alert")] : [])], [e ?? hint]);
    })),
  ]);
}

const tab = (h: H, id: Tab, label: string, active: Tab): Node[] => [
  h.input([h.Class("sr-only"), h.Type("radio"), h.Name("by"), h.Id(`by-${id}`), h.Value(id), h.Checked(id === active), h.OnChange(() => Message.ChangedTab({ tab: id }))]),
  h.label([h.For(`by-${id}`), h.OnClick(Message.ClickedTabLabel({ tab: id }))], [label]),
];

/** The lookup page. */
function lookupView(h: H, model: Model, data: Extract<PageFlags, { kind: "lookup" }>): Node {
  const { input, source, sources, result, error } = data;
  const title = shareTitle(source.name, result);
  const path = resultPath(input, source.id);
  const name = source.name;

  return h.main([...(result || error ? [h.Class("compact")] : []), h.OnMount(PageBehaviors())], [
    h.h1([], ["Did ", creatorPicker(h, source, sources, (id) => resultPath(input, id)), " mention ", h.em([], ["me?"])]),
    h.p([h.Class("lede")], ["We scan every video for X posts on screen, then check the transcript to see if they were read aloud. ", h.a([h.Href(explorePath(source.id))], [`See everything ${name} showed`]), "."]),
    h.div([h.Class("search"), ...(model.busy ? [h.AriaBusy(true)] : [])], [
      h.fieldset([h.Class("tabs")], [
        h.legend([h.Class("sr-only")], ["Search by"]),
        ...tab(h, "handle", "Handle", model.tab),
        ...tab(h, "post", "Post link", model.tab),
        ...tab(h, "text", "Text", model.tab),
        h.span([h.Class("pill"), h.AriaHidden(true)], []),
      ]),
      field(h, source.id, input, error),
    ]),
    ...(result ? results(h, model, result, { url: SITE_ORIGIN + path, title }) : []),
    h.span([h.Class("sr-only"), h.Id("new-tab-hint")], ["Opens in a new tab."]),
    h.footer([], [
      h.p([], [`An image model looks for X posts in the frames of each video. A second model reads them, and the transcript shows if ${name} read them aloud. Results can miss posts or misread a handle.`]),
      h.p([], [h.a([h.Href(explorePath(source.id))], [`Explore every ${name} video we scanned`]), "."]),
      h.p([], [`Not affiliated with ${name}.`]),
    ]),
  ]);
}

export const pageTitle = (page: PageFlags) =>
  page.kind === "lookup" ? shareTitle(page.source.name, page.result) : `What did ${page.source.name} show?`;

export const view = (model: Model, h: H) => ({
  title: pageTitle(model.page),
  body: model.page.kind === "lookup" ? lookupView(h, model, model.page) : exploreView(h, model.page),
});
