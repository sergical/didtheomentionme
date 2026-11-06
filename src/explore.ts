import { SOURCES } from "./config";
import type { Env } from "./env";
import { UNKNOWN_HANDLE, formatTime } from "./pipeline";
import { reading } from "./lookup";
import { NEW_TAB, PICKER_SCRIPT, PLAY, creatorPicker, documentHead, esc, formatDate, hue, plural, saidFigure, youtube, type SourceRef } from "./page";
import { explorePath, resultPath, SITE_ORIGIN } from "./share";

export type ExploreSort = "newest" | "posts";

interface Totals {
  videos: number;
  seconds: number;
  from: string | null;
  to: string | null;
  shown: number;
  aloud: number;
}

interface Account {
  handleNorm: string;
  handle: string;
  shown: number;
  aloud: number;
  videos: number;
}

interface LongRead {
  videoId: string;
  title: string | null;
  handle: string;
  displayName: string | null;
  text: string;
  quote: string;
  readAt: number;
  firstSeen: number;
  lastSeen: number;
  frameSecond: number;
}

interface Video {
  id: string;
  title: string | null;
  publishedAt: string | null;
  duration: number | null;
  shown: number;
  aloud: number;
  accounts: { handle: string; shown: number }[];
}

interface Crossover {
  /** The other creator. */
  other: { id: string; name: string; xHandle: string };
  /** Times this creator showed the other creator's posts. */
  showed: number;
  /** Times the other creator showed this creator's posts. */
  shownBy: number;
}

export interface ExploreData {
  source: SourceRef;
  sources: SourceRef[];
  xHandle: string;
  sort: ExploreSort;
  totals: Totals;
  accounts: Account[];
  /** Posts first seen in each tenth of a video, from the start. */
  position: number[];
  longReads: LongRead[];
  videos: Video[];
  crossovers: Crossover[];
}

const TOP_ACCOUNTS = 12;
const LONG_READS = 4;
// Most stored quotes are comments, not readings, so the query asks for more rows than the page shows.
const LONG_READ_CANDIDATES = 40;
const ACCOUNTS_PER_VIDEO = 24;
const POSITION_BINS = 10;

const DONE = "JOIN videos v ON v.id = m.video_id WHERE v.source = ? AND v.status = 'done'";

export async function exploreData(env: Env, source: SourceRef, sources: SourceRef[], sort: ExploreSort): Promise<ExploreData> {
  const all = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
  const handles = SOURCES.map((s) => s.xHandle.toLowerCase());
  const [[videoTotals], [mentionTotals], accounts, bins, longReads, videos, videoAccounts, crossRows] = await Promise.all([
    all<Pick<Totals, "videos" | "seconds" | "from" | "to">>(
      `SELECT COUNT(*) AS videos, COALESCE(SUM(duration), 0) AS seconds, MIN(published_at) AS "from", MAX(published_at) AS "to"
       FROM videos WHERE source = ? AND status = 'done'`,
      source.id,
    ),
    all<Pick<Totals, "shown" | "aloud">>(
      `SELECT COUNT(*) AS shown, COALESCE(SUM(m.read_aloud_at IS NOT NULL), 0) AS aloud FROM mentions m ${DONE}`,
      source.id,
    ),
    all<Account>(
      `SELECT m.handle_norm AS handleNorm, MAX(m.handle) AS handle, COUNT(*) AS shown,
         SUM(m.read_aloud_at IS NOT NULL) AS aloud, COUNT(DISTINCT m.video_id) AS videos
       FROM mentions m ${DONE} AND m.handle_norm != '' GROUP BY m.handle_norm ORDER BY shown DESC, videos DESC LIMIT ?`,
      source.id, TOP_ACCOUNTS,
    ),
    all<{ bin: number; n: number }>(
      `SELECT MIN(?, CAST(? * m.first_seen / v.duration AS INTEGER)) AS bin, COUNT(*) AS n
       FROM mentions m ${DONE} AND v.duration > 0 GROUP BY bin`,
      POSITION_BINS - 1, POSITION_BINS, source.id,
    ),
    // Read aloud keeps out posts in a sidebar, which can stay on screen for a whole stream.
    all<LongRead>(
      `SELECT m.video_id AS videoId, v.title, m.handle, m.display_name AS displayName, m.text, m.quote, m.read_aloud_at AS readAt,
         m.first_seen AS firstSeen, m.last_seen AS lastSeen, m.frame_second AS frameSecond
       FROM mentions m ${DONE} AND m.read_aloud_at IS NOT NULL
       ORDER BY m.last_seen - m.first_seen DESC LIMIT ?`,
      source.id, LONG_READ_CANDIDATES,
    ),
    all<Omit<Video, "accounts">>(
      `SELECT v.id, v.title, v.published_at AS publishedAt, v.duration, COUNT(m.id) AS shown,
         COALESCE(SUM(m.read_aloud_at IS NOT NULL), 0) AS aloud
       FROM videos v LEFT JOIN mentions m ON m.video_id = v.id
       WHERE v.source = ? AND v.status = 'done' GROUP BY v.id
       ORDER BY ${sort === "posts" ? "shown DESC, " : ""}v.published_at DESC`,
      source.id,
    ),
    all<{ videoId: string; handle: string; shown: number }>(
      `SELECT m.video_id AS videoId, MAX(m.handle) AS handle, COUNT(*) AS shown
       FROM mentions m ${DONE} AND m.handle_norm != '' GROUP BY m.video_id, m.handle_norm ORDER BY shown DESC, handle`,
      source.id,
    ),
    all<{ source: string; handleNorm: string; n: number }>(
      `SELECT v.source, m.handle_norm AS handleNorm, COUNT(*) AS n FROM mentions m JOIN videos v ON v.id = m.video_id
       WHERE v.status = 'done' AND m.handle_norm IN (${handles.map(() => "?").join(",")}) GROUP BY v.source, m.handle_norm`,
      ...handles,
    ),
  ]);

  const byVideo = new Map<string, Video["accounts"]>();
  for (const { videoId, handle, shown } of videoAccounts) {
    const list = byVideo.get(videoId) ?? [];
    list.push({ handle, shown });
    byVideo.set(videoId, list);
  }
  const position = Array.from({ length: POSITION_BINS }, (_, i) => bins.find((b) => b.bin === i)?.n ?? 0);
  const crossCount = (from: string, handle: string) =>
    crossRows.find((r) => r.source === from && r.handleNorm === handle.toLowerCase())?.n ?? 0;
  const self = SOURCES.find((s) => s.id === source.id)!;
  const crossovers = SOURCES.filter((s) => s.id !== source.id).map((s) => ({
    other: { id: s.id, name: s.name, xHandle: s.xHandle },
    showed: crossCount(source.id, s.xHandle),
    shownBy: crossCount(s.id, self.xHandle),
  }));

  return {
    source,
    sources,
    xHandle: self.xHandle,
    sort,
    totals: { ...videoTotals, ...mentionTotals },
    accounts,
    position,
    longReads: realReads(longReads),
    videos: videos.map((v) => ({ ...v, accounts: byVideo.get(v.id) ?? [] })),
    crossovers,
  };
}

/** Readings, not comments, with one card for each frame or quote. Two rows can share both when one post was read twice. */
function realReads(rows: LongRead[]): LongRead[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const keys = [`${r.videoId}:${r.frameSecond}`, `${r.videoId}:${r.quote}`];
    if (reading(r.quote, r.text) === "comment" || keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  }).slice(0, LONG_READS);
}

const EXPLORE_STYLE = `
main.explore { max-width: 46rem; }
.back { display: inline-flex; align-items: center; min-height: 44px; margin: -.75rem 0 .5rem; color: var(--muted); font-size: .9375rem; text-decoration: none; }
@media (hover: hover) and (pointer: fine) { .back:hover { color: var(--fg); } }
.back:focus-visible, .explore a:focus-visible, .explore summary:focus-visible, .col:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; border-radius: 6px; }

.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: .75rem; margin: 0 0 3.5rem; }
@media (min-width: 40rem) { .stats { grid-template-columns: repeat(4, 1fr); } }
.stats div { padding: 1rem 1.125rem; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow); }
.stats dt { font-size: .8125rem; color: var(--muted); }
.stats dd { margin: .125rem 0 0; font-size: clamp(1.75rem, 6vw, 2.25rem); font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; }

.explore section { margin: 0 0 3.5rem; }
.explore h2 { margin: 0; font-size: 1.375rem; letter-spacing: -0.02em; font-weight: 700; }
.sub { margin: .25rem 0 1.25rem; color: var(--muted); text-wrap: pretty; }
.sub a, .lede a, footer a { color: var(--fg); text-underline-offset: 3px; }

.ranks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.ranks a { display: grid; grid-template-columns: 1.5rem 2rem minmax(0, 1fr) auto; align-items: center; column-gap: .75rem; row-gap: .375rem;
  min-height: 44px; padding: .625rem .75rem; border-radius: 12px; text-decoration: none; transition: background-color 150ms ease-out; }
@media (hover: hover) and (pointer: fine) { .ranks a:hover { background: var(--surface); } }
.ranks a:active { background: var(--surface); transition-duration: 0ms; }
.rank { color: var(--muted); font-size: .875rem; font-variant-numeric: tabular-nums; text-align: right; }
.ranks .avatar { grid-row: span 2; width: 2rem; height: 2rem; font-size: .875rem; }
.ranks .rank { grid-row: span 2; }
.who-line { display: flex; align-items: baseline; gap: .5rem; min-width: 0; }
.who-line b { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }
.meta { grid-column: 3 / 5; display: flex; align-items: center; gap: .75rem; font-size: .8125rem; color: var(--muted); }
.track { flex: 1; height: 8px; }
.track span { display: block; height: 100%; width: var(--w); min-width: 4px; border-radius: 0 4px 4px 0; background: var(--accent); }
.crossover { margin: 1.25rem 0 0; padding: .875rem 1rem; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); color: var(--muted); }
.crossover a { color: var(--fg); text-underline-offset: 3px; }

.hist { display: grid; grid-template-columns: repeat(${POSITION_BINS}, 1fr); align-items: end; gap: 2px; height: 11rem; padding: 1.75rem 0 0;
  border-bottom: 1px solid var(--line-strong); list-style: none; margin: 0; }
.col { position: relative; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
.col span { width: min(100%, 24px); height: var(--h); min-height: 2px; border-radius: 4px 4px 0 0; background: var(--accent); opacity: .55; transition: opacity 150ms ease; }
.col.peak span { opacity: 1; }
.col b { position: absolute; bottom: calc(var(--h) + .375rem); font-size: .8125rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap;
  visibility: hidden; }
.col.peak b, .col:hover b, .col:focus-visible b { visibility: visible; }
.hist:has(.col:hover, .col:focus-visible) .col.peak:not(:hover, :focus-visible) b { visibility: hidden; }
.col:hover span, .col:focus-visible span { opacity: 1; }
.axis { display: flex; justify-content: space-between; margin-top: .5rem; font-size: .8125rem; color: var(--muted); }

.reads { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
@media (min-width: 40rem) { .reads { grid-template-columns: 1fr 1fr; } }
.reads .match { animation: none; }
.reads blockquote { -webkit-line-clamp: 3; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

.sorts { display: flex; gap: .25rem; margin: 0 0 .75rem; }
.sorts a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 .875rem; border-radius: 10px; color: var(--muted); font-size: .9375rem; font-weight: 600; text-decoration: none; }
.sorts a[aria-current] { background: var(--surface-2); color: var(--fg); box-shadow: 0 0 0 1px var(--line-strong); }
@media (hover: hover) and (pointer: fine) { .sorts a:not([aria-current]):hover { color: var(--fg); } }
.videos { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.videos > li { border-bottom: 1px solid var(--line); }
.videos summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .375rem 1rem; padding: .875rem .25rem; cursor: pointer; list-style: none; }
.videos summary::-webkit-details-marker { display: none; }
.videos summary .title { font-weight: 600; overflow-wrap: anywhere; }
.videos summary .count { align-self: start; }
.videos summary .meta { grid-column: 1 / -1; }
.videos time { white-space: nowrap; }
.videos .track { max-width: 12rem; }
.videos .none { color: var(--muted); font-weight: 500; }
@media (hover: hover) and (pointer: fine) { .videos summary:hover .title { text-decoration: underline; text-underline-offset: 3px; } }
.opened { padding: 0 .25rem 1.25rem; display: grid; gap: .875rem; }
.handles { display: flex; flex-wrap: wrap; gap: .375rem; list-style: none; margin: 0; padding: 0; }
.handles a { display: inline-flex; align-items: center; gap: .375rem; min-height: 32px; padding: .25rem .625rem; border-radius: 99px; background: var(--surface-2);
  font-size: .8125rem; font-weight: 550; text-decoration: none; font-variant-numeric: tabular-nums; }
.handles a small { color: var(--muted); font-size: inherit; }
@media (hover: hover) and (pointer: fine) { .handles a:hover { box-shadow: 0 0 0 1px var(--line-strong); } }
.opened > p { margin: 0; font-size: .875rem; color: var(--muted); }
.opened > p a { color: var(--fg); text-underline-offset: 3px; }
`;

const number = (n: number) => n.toLocaleString("en-US");
const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);
const handleOf = (handle: string) => (handle.startsWith("@") ? handle : `@${handle}`);
const searchLink = (handle: string, source: string) => resultPath({ handle: handle.replace(/^@/, ""), tweet: "" }, source);

function stats({ totals }: ExploreData): string {
  const tiles: [string, string][] = [
    ["Videos scanned", number(totals.videos)],
    ["Hours of video", number(Math.round(totals.seconds / 3600))],
    ["Posts on screen", number(totals.shown)],
    ["Read aloud", `${percent(totals.aloud, totals.shown)}%`],
  ];
  return `<dl class="stats">${tiles.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function accounts(data: ExploreData): string {
  const { accounts: list, source, xHandle } = data;
  if (list.length === 0) return "";
  const max = list[0].shown;
  const rows = list.map((a, i) => {
    const handle = handleOf(a.handle);
    const own = a.handleNorm === xHandle.toLowerCase() ? `<span class="badge">Own account</span>` : "";
    const aloud = a.aloud ? ` · ${number(a.aloud)} read aloud` : "";
    return `<li><a href="${esc(searchLink(a.handle, source.id))}">
<span class="rank">${i + 1}</span><span class="avatar" style="--hue:${hue(handle)}" aria-hidden="true">${esc(handle.charAt(1).toUpperCase())}</span>
<span class="who-line"><b>${esc(handle)}</b>${own}</span><span class="count">${number(a.shown)}<span class="sr-only"> times on screen</span></span>
<span class="meta"><span class="track" aria-hidden="true"><span style="--w:${((100 * a.shown) / max).toFixed(1)}%"></span></span>${plural(a.videos, "video")}${aloud}</span>
</a></li>`;
  });
  const cross = data.crossovers
    .filter((c) => c.showed || c.shownBy)
    .map((c) =>
      `<p class="crossover">${esc(source.name)} showed <a href="${esc(searchLink(c.other.xHandle, source.id))}">@${esc(c.other.xHandle)}</a> ${plural(c.showed, "time")}. ` +
      `${esc(c.other.name)} showed <a href="${esc(searchLink(xHandle, c.other.id))}">@${esc(xHandle)}</a> ${plural(c.shownBy, "time")}.</p>`)
    .join("");
  return `<section aria-labelledby="accounts">
<h2 id="accounts">Most shown accounts</h2>
<p class="sub">Times each account was on screen across every video. Open one to see each moment.</p>
<ol class="ranks">${rows.join("")}</ol>
${cross}
</section>`;
}

function position(data: ExploreData): string {
  const bins = data.position;
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return "";
  const max = Math.max(...bins);
  const peak = bins.indexOf(max);
  const firstHalf = percent(bins.slice(0, POSITION_BINS / 2).reduce((a, b) => a + b, 0), total);
  const lead = firstHalf >= 50 ? `${firstHalf}% of posts show up in the first half of a video.` : `${100 - firstHalf}% of posts show up in the second half of a video.`;
  const step = 100 / POSITION_BINS;
  const cols = bins.map((n, i) => {
    const label = `${i * step}–${(i + 1) * step}% of the way through: ${plural(n, "post")}`;
    return `<li class="col${i === peak ? " peak" : ""}" tabindex="0" aria-label="${label}" style="--h:${((100 * n) / max).toFixed(1)}%"><b aria-hidden="true">${number(n)}</b><span></span></li>`;
  });
  return `<section aria-labelledby="when">
<h2 id="when">When posts show up</h2>
<p class="sub">${lead} Each bar is one tenth of a video.</p>
<ol class="hist">${cols.join("")}</ol>
<div class="axis" aria-hidden="true"><span>Start</span><span>Middle</span><span>End</span></div>
</section>`;
}

const minutes = (seconds: number) => (seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);

function longReads({ longReads: list, source }: ExploreData): string {
  if (list.length === 0) return "";
  const cards = list.map((r) => {
    const known = r.handle !== UNKNOWN_HANDLE;
    const name = r.displayName || (known ? r.handle.replace(/^@/, "") : "Unknown account");
    const at = youtube(r.videoId, r.firstSeen);
    return `<li class="match">
<a class="frame" ${NEW_TAB} href="${at}" tabindex="-1" aria-hidden="true"><img src="/frame/${esc(r.videoId)}/${r.frameSecond}.jpg" alt="" loading="lazy" decoding="async"></a>
<div class="body">
<div class="video"><a ${NEW_TAB} href="${at}">${esc(r.title ?? r.videoId)}</a></div>
<p class="who"><b>${esc(name)}</b>${known ? `<span>${esc(r.handle)}</span>` : ""}</p>
${saidFigure(source.name, r.videoId, { at: r.readAt, quote: r.quote, reading: reading(r.quote, r.text) })}
<p class="times"><span>On screen for ${minutes(r.lastSeen - r.firstSeen)} from</span><a class="chip" ${NEW_TAB} href="${at}">${PLAY}${formatTime(r.firstSeen)}</a></p>
</div>
</li>`;
  });
  return `<section aria-labelledby="long">
<h2 id="long">Read aloud and kept on screen</h2>
<p class="sub">The posts ${esc(source.name)} read out and stayed on the longest.</p>
<ol class="reads">${cards.join("")}</ol>
</section>`;
}

function videos(data: ExploreData): string {
  const { source, sort } = data;
  const max = Math.max(1, ...data.videos.map((v) => v.shown));
  const sortLink = (to: ExploreSort, label: string) =>
    `<a href="${esc(explorePath(source.id, to))}#videos"${sort === to ? ' aria-current="true"' : ""}>${label}</a>`;
  const rows = data.videos.map((v) => {
    const count = v.shown ? `${number(v.shown)}<span class="sr-only"> posts</span>` : `<span class="none">None</span>`;
    const meta = [
      `<time datetime="${esc(v.publishedAt)}">${esc(formatDate(v.publishedAt))}</time>`,
      v.duration ? formatTime(v.duration) : "",
      v.aloud ? `${number(v.aloud)} read aloud` : "",
    ].filter(Boolean).join(" · ");
    const shown = v.accounts.slice(0, ACCOUNTS_PER_VIDEO).map((a) =>
      `<li><a href="${esc(searchLink(a.handle, source.id))}">${esc(handleOf(a.handle))}${a.shown > 1 ? ` <small>×${a.shown}</small>` : ""}</a></li>`);
    const rest = v.accounts.length - shown.length;
    const watch = `<a ${NEW_TAB} href="${youtube(v.id, 0)}">Watch on YouTube</a>`;
    const body = v.accounts.length
      ? `<ul class="handles" aria-label="Accounts on screen">${shown.join("")}</ul><p>${plural(v.accounts.length, "account")} on screen${rest > 0 ? `, the ${rest} least shown not listed` : ""}. ${watch}</p>`
      : `<p>No X posts found on screen. ${watch}</p>`;
    return `<li><details><summary>
<span class="title">${esc(v.title ?? v.id)}</span><span class="count">${count}</span>
<span class="meta"><span class="track" aria-hidden="true">${v.shown ? `<span style="--w:${((100 * v.shown) / max).toFixed(1)}%"></span>` : ""}</span><span>${meta}</span></span>
</summary><div class="opened">${body}</div></details></li>`;
  });
  return `<section aria-labelledby="videos">
<h2 id="videos">Every video</h2>
<p class="sub">${plural(data.videos.length, "video")} and the posts on screen in each. Open one to see the accounts.</p>
<nav class="sorts" aria-label="Sort videos">${sortLink("newest", "Newest")}${sortLink("posts", "Most posts")}</nav>
<ol class="videos">${rows.join("")}</ol>
</section>`;
}

export function renderExplore(data: ExploreData): string {
  const { source, totals } = data;
  const name = esc(source.name);
  const path = explorePath(source.id, data.sort);
  const range = totals.videos ? `, ${esc(formatDate(totals.from, false))} to ${esc(formatDate(totals.to))}` : "";
  const title = `What did ${source.name} show?`;
  const description = `Every X post ${source.name} showed on screen in ${plural(totals.videos, "video")}, with the most shown accounts.`;
  return `${documentHead({
    title,
    description,
    metaDescription: description,
    canonical: SITE_ORIGIN + path,
    image: `${SITE_ORIGIN}/og.png?source=${encodeURIComponent(source.id)}`,
    hue: source.hue,
    style: EXPLORE_STYLE,
  })}<body>
<main class="explore">
<a class="back" href="${esc(resultPath({ handle: "", tweet: "" }, source.id))}">← Search for your posts</a>
<h1>What did ${creatorPicker(source, data.sources, (id) => explorePath(id, data.sort))} <em>show?</em></h1>
<p class="lede">Every X post we found on screen in ${plural(totals.videos, `${name} video`)}${range}.</p>
${stats(data)}
${accounts(data)}
${position(data)}
${longReads(data)}
${videos(data)}
<span class="sr-only" id="new-tab-hint">Opens in a new tab.</span>
<footer>
<p>An image model finds X posts in one frame per second of each video, and a second model reads them. Counts can include misread handles.</p>
<p>Not affiliated with ${name}.</p>
</footer>
</main>
<script>${PICKER_SCRIPT}</script>
</body>
</html>`;
}
