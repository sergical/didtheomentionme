/** The explore page. */
import { UNKNOWN_HANDLE, formatTime } from "../pipeline";
import { explorePath, resultPath } from "../share";
import { PageBehaviors } from "./behaviors";
import type { PageFlags } from "./model";
import { PLAY, at, creatorPicker, icon, saidFigure, youtube, type Child, type H, type Node } from "./parts";
import { formatDate, hue, plural } from "./text";

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

type ExploreVideo = Explore["videos"][number];

/** The accounts a video showed, most shown first, and a link to watch it. */
function videoAccounts(h: H, v: ExploreVideo, sourceId: string): Node[] {
  const shown = v.accounts.slice(0, ACCOUNTS_PER_VIDEO).map((a) =>
    h.li([], [h.a([h.Href(searchLink(a.handle, sourceId))], [handleOf(a.handle), ...(a.shown > 1 ? [" ", h.small([], [`×${a.shown}`])] : [])])]));

  const rest = v.accounts.length - shown.length;
  const watch = h.a([...at(h).newTab, h.Href(youtube(v.id, 0))], ["Watch on YouTube"]);

  if (v.accounts.length === 0) return [h.p([], ["No X posts found on screen. ", watch])];

  return [h.ul([h.Class("handles"), h.AriaLabel("Accounts on screen")], shown), h.p([], [`${plural(v.accounts.length, "account")} on screen${rest > 0 ? `, the ${rest} least shown not listed` : ""}. `, watch])];
}

/** One video of the list. `max` is the most posts any video showed, for the width of its bar. */
function videoRow(h: H, v: ExploreVideo, sourceId: string, max: number): Node {
  const count: Child[] = v.shown ? [number(v.shown), h.span([h.Class("sr-only")], [" posts"])] : [h.span([h.Class("none")], ["None"])];
  const meta: Child[] = [h.time([h.Attribute("datetime", v.publishedAt ?? "")], [formatDate(v.publishedAt)])];

  for (const part of [v.duration ? formatTime(v.duration) : "", v.aloud ? `${number(v.aloud)} read aloud` : ""]) if (part) meta.push(` · ${part}`);

  return h.li([], [h.details([], [
    h.summary([], [
      h.span([h.Class("title")], [v.title ?? v.id]),
      h.span([h.Class("count")], count),
      h.span([h.Class("meta")], [
        h.span([h.Class("track"), h.AriaHidden(true)], v.shown ? [h.span([h.Attribute("style", `--w:${((100 * v.shown) / max).toFixed(1)}%`)], [])] : []),
        h.span([], meta),
      ]),
    ]),
    h.div([h.Class("opened")], videoAccounts(h, v, sourceId)),
  ])]);
}

function videoList(h: H, data: Explore): Node {
  const { source, sort } = data;
  const max = Math.max(1, ...data.videos.map((v) => v.shown));

  const sortLink = (to: "newest" | "posts", label: string) =>
    h.a([h.Href(`${explorePath(source.id, to)}#videos`), ...(sort === to ? [h.Attribute("aria-current", "true")] : [])], [label]);

  const rows = data.videos.map((v) => videoRow(h, v, source.id, max));

  return h.section([h.AriaLabelledBy("videos")], [
    h.h2([h.Id("videos")], ["Every video"]),
    h.p([h.Class("sub")], [`${plural(data.videos.length, "video")} and the posts on screen in each. Open one to see the accounts.`]),
    h.nav([h.Class("sorts"), h.AriaLabel("Sort videos")], [sortLink("newest", "Newest"), sortLink("posts", "Most posts")]),
    h.ol([h.Class("videos")], rows),
  ]);
}

export function exploreView(h: H, data: Explore): Node {
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
