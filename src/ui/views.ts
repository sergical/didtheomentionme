/**
 * The two pages as Foldkit views. The server renders them to HTML, and the browser hydrates the same views, so these
 * functions must stay pure: no `document`, `window` or `navigator`.
 */
import type { Attribute, HtmlBuilder } from "foldkit/html";
import type { LookupResult, Match, Reading } from "../lookup";
import { UNKNOWN_HANDLE, formatTime } from "../pipeline";
import { explorePath, resultPath, shareTitle, SITE_ORIGIN } from "../share";
import { PageBehaviors } from "./behaviors";
import { Message, type Model, type PageFlags, type SourceRef, type Tab } from "./model";
import { formatDate, hue, plural } from "./text";

type H = HtmlBuilder<Message>;
type Node = ReturnType<H["div"]>;
type Child = Node | string;

const WORDS = /[\p{L}\p{N}]+/gu;
/** A text match with at least this share of the query words is shown as a close match. */
const CLOSE_MATCH = 0.75;
const SHOWN = 10;

export const youtube = (videoId: string, seconds: number) =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(seconds)}s`;

type Icon = (h: H) => Node;
const svg = (h: H, viewBox: string, d: string, paint: Attribute<Message>[]) =>
  h.svg([h.ViewBox(viewBox), h.AriaHidden(true)], [h.path([h.Attribute("d", d), ...paint], [])]);
const stroke = (h: H, width: string): Attribute<Message>[] => [h.Fill("none"), h.Attribute("stroke", "currentColor"), h.Attribute("stroke-width", width),
  h.Attribute("stroke-linecap", "round"), h.Attribute("stroke-linejoin", "round")];
const PLAY: Icon = (h) => svg(h, "0 0 10 12", "M0 0v12l10-6z", [h.Fill("currentColor")]);
const CHEVRON: Icon = (h) => svg(h, "0 0 12 12", "M2.5 4.5 6 8l3.5-3.5", stroke(h, "1.75"));
const CHECK: Icon = (h) => svg(h, "0 0 16 16", "m3.5 8.5 3 3 6-7", stroke(h, "2"));

/** Shorthands for attributes the builder names differently from HTML. */
const at = (h: H) => ({
  newTab: [h.Attribute("target", "_blank"), h.Attribute("rel", "noopener noreferrer"), h.Attribute("aria-describedby", "new-tab-hint")],
  attr: (name: string, value: string | number) => h.Attribute(name, String(value)),
});

const icon = (h: H, make: Icon) => make(h);

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

const face = (h: H, { id, avatar }: SourceRef) =>
  h.img([h.Class("face"), h.Src(avatar), h.Alt(""), h.Width("96"), h.Height("96"), h.Attribute("referrerpolicy", "no-referrer"), h.Attribute("style", `--hue:${hue(id)}`)]);

export function creatorPicker(h: H, source: SourceRef, sources: SourceRef[], href: (id: string) => string): Child {
  if (sources.length < 2) return source.name;
  const { attr } = at(h);
  const names = sources.map((s) => h.span(s.id === source.id ? [] : [h.AriaHidden(true)], [s.name]));
  const items = sources.map((s) => {
    const c = s.coverage;
    const meta = c.videos ? `${plural(c.videos, "video")} · ${formatDate(c.from, false)} to ${formatDate(c.to, false)}` : "First videos in progress";
    const current = s.id === source.id;
    return h.a([h.Href(href(s.id)), ...(current ? [attr("aria-current", "page")] : [])], [face(h, s), s.name, h.small([], [meta]), ...(current ? [icon(h, CHECK)] : [])]);
  });
  return h.details([h.Class("pick")], [
    h.summary([], [face(h, source), h.span([h.Class("names")], names), icon(h, CHEVRON)]),
    h.nav([h.Class("menu"), h.AriaLabel("Creators")], items),
  ]);
}

const READING_CAPTION: Record<Reading, string> = { all: "read it aloud", part: "read part of it aloud", comment: "talked about it" };

export const saidFigure = (h: H, sourceName: string, videoId: string, { at: time, quote, reading }: { at: number; quote: string; reading: Reading }) =>
  h.figure([h.Class(`said${reading === "comment" ? " comment" : ""}`)], [
    h.blockquote([], [quote]),
    h.figcaption([], [`${sourceName} ${READING_CAPTION[reading]} at `, h.a([...at(h).newTab, h.Href(youtube(videoId, time))], [formatTime(time)])]),
  ]);

const switchTab = (h: H, tab: Tab, label: string) => h.button([h.Type("button"), h.Class("switch"), h.OnClick(Message.ClickedSwitchTab({ tab }))], [label]);

function verdict(h: H, result: LookupResult, close: Match[], loose: Match[]): Node {
  const { name } = result.source;
  const { videos, from, to } = result.coverage;
  const about = result.query ? `“${result.query}”` : `@${result.handle}`;
  const section = (kind: string, answer: string, detail: Child[]) =>
    h.section([h.Class(`verdict ${kind}`)], [h.p([h.Class("about")], [about]), h.h2([], [answer]), h.p([], detail)]);

  if (close.length === 0) {
    if (loose.length) return section("maybe", "Not exactly.", [`No post has most of these words. ${plural(loose.length, "post")} ${loose.length === 1 ? "has" : "have"} some of them.`]);
    if (videos === 0) return section("no", "Not yet.", [`No ${name} videos are indexed yet.`]);
    const next: Child[] = result.query
      ? ["Try other words, or ", switchTab(h, "handle", "search by handle"), "."]
      : ["Handle cropped out of the screenshot? ", switchTab(h, "text", "Search by words from the post"), "."];
    return section("no", "Not yet.", [`Nothing in the ${plural(videos, "video")} from ${formatDate(from, false)} to ${formatDate(to)}. `, ...next]);
  }
  const read = close.filter((m) => m.readAloud && m.readAloud.reading !== "comment").length;
  const talked = close.filter((m) => m.readAloud?.reading === "comment").length;
  const one = close.length === 1;
  const shown = result.query ? `${name} showed ${plural(close.length, "post")} with that text` : `${name} showed ${one ? "your post" : `${close.length} of your posts`}`;
  const count = (n: number) => (n < close.length ? String(n) : one ? "it" : close.length === 2 ? "both" : "every one");
  const readCount = one && close[0].readAloud?.reading === "part" ? "part of it" : count(read);
  const notRead = `but did not read ${one ? "it" : "them"} aloud.`;
  const said = read && talked
    ? `, read ${readCount} aloud and talked about ${count(talked)}.`
    : read ? ` and read ${readCount} aloud.`
    : talked ? ` and talked about ${count(talked)}, ${notRead}`
    : `, ${notRead}`;
  return section("yes", "Yes.", [shown + said]);
}

function card(h: H, m: Match, i: number, words: Set<string>, sourceName: string, showText: boolean, eager: boolean): Node {
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

function shareControls(h: H, model: Model, url: string, title: string): Node {
  const intent = `https://x.com/intent/post?${new URLSearchParams({ text: `${title} Found the receipts.`, url })}`;
  const copied = (button: "share" | "copy", label: string) => (model.copied === button ? "✓ Copied" : label);
  return h.div([h.Class("share")], [
    h.button([h.Type("button"), h.Class("share-primary"), h.Attribute("data-share", ""), h.OnClick(Message.ClickedShare({ url, title }))], [copied("share", "Share result")]),
    h.button([h.Type("button"), h.Attribute("data-copy", ""), h.Hidden(model.hideCopy), h.OnClick(Message.ClickedCopy({ url }))], [copied("copy", "Copy link")]),
    h.a([h.Href(intent), ...at(h).newTab], ["Post on X ↗"]),
    h.span([h.Class(`share-status${model.statusVisible ? "" : " sr-only"}`), h.Role("status"), h.AriaLive("polite")], [model.status]),
  ]);
}

function results(h: H, model: Model, result: LookupResult, url: string, title: string): Child[] {
  const words = new Set(result.query ? result.query.toLowerCase().match(WORDS) : []);
  const isClose = (m: Match) => !result.query || (m.overlap ?? 0) >= CLOSE_MATCH;
  const close = result.matches.filter(isClose);
  const loose = result.matches.filter((m) => !isClose(m));
  const cards = (list: Match[], eager = false) =>
    h.ol([h.Class("matches")], list.map((m, i) => card(h, m, i, words, result.source.name, Boolean(result.query || result.tweet), eager)));
  return [
    verdict(h, result, close, loose),
    shareControls(h, model, url, title),
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

/** The field box with every tab's input. A lookup error replaces the hint of the active tab, next to the field it is about. */
function field(h: H, model: Model, sourceId: string, input: { handle: string; tweet: string; q?: string }, error: string | undefined): Node {
  const entries = ENTRIES(input);
  const errorFor = (id: Tab) => (id === model.tab ? error : undefined);
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
      field(h, model, source.id, input, error),
    ]),
    ...(result ? results(h, model, result, SITE_ORIGIN + path, title) : []),
    h.span([h.Class("sr-only"), h.Id("new-tab-hint")], ["Opens in a new tab."]),
    h.footer([], [
      h.p([], [`An image model looks for X posts in the frames of each video. A second model reads them, and the transcript shows if ${name} read them aloud. Results can miss posts or misread a handle.`]),
      h.p([], [h.a([h.Href(explorePath(source.id))], [`Explore every ${name} video we scanned`]), "."]),
      h.p([], [`Not affiliated with ${name}.`]),
    ]),
  ]);
}

const number = (n: number) => n.toLocaleString("en-US");
const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);
const handleOf = (handle: string) => (handle.startsWith("@") ? handle : `@${handle}`);
const searchLink = (handle: string, source: string) => resultPath({ handle: handle.replace(/^@/, ""), tweet: "" }, source);
const minutes = (seconds: number) => (seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);
const ACCOUNTS_PER_VIDEO = 24;

type Explore = Extract<PageFlags, { kind: "explore" }>;

function stats(h: H, { totals }: Explore): Node {
  const tiles: [string, string][] = [
    ["Videos scanned", number(totals.videos)],
    ["Hours of video", number(Math.round(totals.seconds / 3600))],
    ["Posts on screen", number(totals.shown)],
    ["Read aloud", `${percent(totals.aloud, totals.shown)}%`],
  ];
  return h.dl([h.Class("stats")], tiles.map(([label, value]) => h.div([], [h.dt([], [label]), h.dd([], [value])])));
}

function accounts(h: H, data: Explore): Node[] {
  const { accounts: list, source, xHandle } = data;
  if (list.length === 0) return [];
  const max = list[0].shown;
  const rows = list.map((a, i) => {
    const handle = handleOf(a.handle);
    const own = a.handleNorm === xHandle.toLowerCase() ? [h.span([h.Class("badge")], ["Own account"])] : [];
    const aloud = a.aloud ? ` · ${number(a.aloud)} read aloud` : "";
    return h.li([], [h.a([h.Href(searchLink(a.handle, source.id))], [
      h.span([h.Class("rank")], [String(i + 1)]),
      h.span([h.Class("avatar"), h.Attribute("style", `--hue:${hue(handle)}`), h.AriaHidden(true)], [handle.charAt(1).toUpperCase()]),
      h.span([h.Class("who-line")], [h.b([], [handle]), ...own]),
      h.span([h.Class("count")], [number(a.shown), h.span([h.Class("sr-only")], [" times on screen"])]),
      h.span([h.Class("meta")], [
        h.span([h.Class("track"), h.AriaHidden(true)], [h.span([h.Attribute("style", `--w:${((100 * a.shown) / max).toFixed(1)}%`)], [])]),
        `${plural(a.videos, "video")}${aloud}`,
      ]),
    ])]);
  });
  const cross = data.crossovers.filter((c) => c.showed || c.shownBy).map((c) =>
    h.p([h.Class("crossover")], [
      `${source.name} showed `, h.a([h.Href(searchLink(c.other.xHandle, source.id))], [`@${c.other.xHandle}`]), ` ${plural(c.showed, "time")}. `,
      `${c.other.name} showed `, h.a([h.Href(searchLink(xHandle, c.other.id))], [`@${xHandle}`]), ` ${plural(c.shownBy, "time")}.`,
    ]));
  return [h.section([h.AriaLabelledBy("accounts")], [
    h.h2([h.Id("accounts")], ["Most shown accounts"]),
    h.p([h.Class("sub")], ["Times each account was on screen across every video. Open one to see each moment."]),
    h.ol([h.Class("ranks")], rows),
    ...cross,
  ])];
}

function position(h: H, data: Explore): Node[] {
  const bins = data.position;
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const max = Math.max(...bins);
  const peak = bins.indexOf(max);
  const firstHalf = percent(bins.slice(0, bins.length / 2).reduce((a, b) => a + b, 0), total);
  const lead = firstHalf >= 50 ? `${firstHalf}% of posts show up in the first half of a video.` : `${100 - firstHalf}% of posts show up in the second half of a video.`;
  const step = 100 / bins.length;
  const cols = bins.map((n, i) =>
    h.li([h.Class(`col${i === peak ? " peak" : ""}`), h.Tabindex(0), h.AriaLabel(`${i * step}–${(i + 1) * step}% of the way through: ${plural(n, "post")}`), h.Attribute("style", `--h:${((100 * n) / max).toFixed(1)}%`)], [
      h.b([h.AriaHidden(true)], [number(n)]),
      h.span([], []),
    ]));
  return [h.section([h.AriaLabelledBy("when")], [
    h.h2([h.Id("when")], ["When posts show up"]),
    h.p([h.Class("sub")], [`${lead} Each bar is one tenth of a video.`]),
    h.ol([h.Class("hist")], cols),
    h.div([h.Class("axis"), h.AriaHidden(true)], [h.span([], ["Start"]), h.span([], ["Middle"]), h.span([], ["End"])]),
  ])];
}

function longReads(h: H, { longReads: list, source }: Explore): Node[] {
  if (list.length === 0) return [];
  const { newTab } = at(h);
  const cards = list.map((r) => {
    const known = r.handle !== UNKNOWN_HANDLE;
    const name = r.displayName || (known ? r.handle.replace(/^@/, "") : "Unknown account");
    const link = youtube(r.videoId, r.firstSeen);
    return h.li([h.Class("match")], [
      h.a([h.Class("frame"), ...newTab, h.Href(link), h.Tabindex(-1), h.AriaHidden(true)], [h.img([h.Src(`/frame/${r.videoId}/${r.frameSecond}.jpg`), h.Alt(""), h.Loading("lazy"), h.Decoding("async")])]),
      h.div([h.Class("body")], [
        h.div([h.Class("video")], [h.a([...newTab, h.Href(link)], [r.title ?? r.videoId])]),
        h.p([h.Class("who")], [h.b([], [name]), ...(known ? [h.span([], [r.handle])] : [])]),
        saidFigure(h, source.name, r.videoId, { at: r.readAt, quote: r.quote, reading: r.reading }),
        h.p([h.Class("times")], [h.span([], [`On screen for ${minutes(r.lastSeen - r.firstSeen)} from`]), h.a([h.Class("chip"), ...newTab, h.Href(link)], [icon(h, PLAY), formatTime(r.firstSeen)])]),
      ]),
    ]);
  });
  return [h.section([h.AriaLabelledBy("long")], [
    h.h2([h.Id("long")], ["Read aloud and kept on screen"]),
    h.p([h.Class("sub")], [`The posts ${source.name} read out and stayed on the longest.`]),
    h.ol([h.Class("reads")], cards),
  ])];
}

function videoList(h: H, data: Explore): Node {
  const { source, sort } = data;
  const max = Math.max(1, ...data.videos.map((v) => v.shown));
  const sortLink = (to: "newest" | "posts", label: string) =>
    h.a([h.Href(`${explorePath(source.id, to)}#videos`), ...(sort === to ? [h.Attribute("aria-current", "true")] : [])], [label]);
  const rows = data.videos.map((v) => {
    const count: Child[] = v.shown ? [number(v.shown), h.span([h.Class("sr-only")], [" posts"])] : [h.span([h.Class("none")], ["None"])];
    const meta: Child[] = [h.time([h.Attribute("datetime", v.publishedAt ?? "")], [formatDate(v.publishedAt)])];
    for (const part of [v.duration ? formatTime(v.duration) : "", v.aloud ? `${number(v.aloud)} read aloud` : ""]) if (part) meta.push(` · ${part}`);
    const shown = v.accounts.slice(0, ACCOUNTS_PER_VIDEO).map((a) =>
      h.li([], [h.a([h.Href(searchLink(a.handle, source.id))], [handleOf(a.handle), ...(a.shown > 1 ? [" ", h.small([], [`×${a.shown}`])] : [])])]));
    const rest = v.accounts.length - shown.length;
    const watch = h.a([...at(h).newTab, h.Href(youtube(v.id, 0))], ["Watch on YouTube"]);
    const body = v.accounts.length
      ? [h.ul([h.Class("handles"), h.AriaLabel("Accounts on screen")], shown), h.p([], [`${plural(v.accounts.length, "account")} on screen${rest > 0 ? `, the ${rest} least shown not listed` : ""}. `, watch])]
      : [h.p([], ["No X posts found on screen. ", watch])];
    return h.li([], [h.details([], [
      h.summary([], [
        h.span([h.Class("title")], [v.title ?? v.id]),
        h.span([h.Class("count")], count),
        h.span([h.Class("meta")], [
          h.span([h.Class("track"), h.AriaHidden(true)], v.shown ? [h.span([h.Attribute("style", `--w:${((100 * v.shown) / max).toFixed(1)}%`)], [])] : []),
          h.span([], meta),
        ]),
      ]),
      h.div([h.Class("opened")], body),
    ])]);
  });
  return h.section([h.AriaLabelledBy("videos")], [
    h.h2([h.Id("videos")], ["Every video"]),
    h.p([h.Class("sub")], [`${plural(data.videos.length, "video")} and the posts on screen in each. Open one to see the accounts.`]),
    h.nav([h.Class("sorts"), h.AriaLabel("Sort videos")], [sortLink("newest", "Newest"), sortLink("posts", "Most posts")]),
    h.ol([h.Class("videos")], rows),
  ]);
}

/** The explore page. */
function exploreView(h: H, data: Explore): Node {
  const { source, totals } = data;
  const range = totals.videos ? `, ${formatDate(totals.from, false)} to ${formatDate(totals.to)}` : "";
  return h.main([h.Class("explore"), h.OnMount(PageBehaviors())], [
    h.a([h.Class("back"), h.Href(resultPath({ handle: "", tweet: "" }, source.id))], ["← Search for your posts"]),
    h.h1([], ["What did ", creatorPicker(h, source, data.sources, (id) => explorePath(id, data.sort)), " ", h.em([], ["show?"])]),
    h.p([h.Class("lede")], [`Every X post we found on screen in ${plural(totals.videos, `${source.name} video`)}${range}.`]),
    stats(h, data),
    ...accounts(h, data),
    ...position(h, data),
    ...longReads(h, data),
    videoList(h, data),
    h.span([h.Class("sr-only"), h.Id("new-tab-hint")], ["Opens in a new tab."]),
    h.footer([], [
      h.p([], ["An image model finds X posts in one frame per second of each video, and a second model reads them. Counts can include misread handles."]),
      h.p([], [`Not affiliated with ${source.name}.`]),
    ]),
  ]);
}

export const pageTitle = (page: PageFlags) =>
  page.kind === "lookup" ? shareTitle(page.source.name, page.result) : `What did ${page.source.name} show?`;

export const view = (model: Model, h: H) => ({
  title: pageTitle(model.page),
  body: model.page.kind === "lookup" ? lookupView(h, model, model.page) : exploreView(h, model.page),
});
