import { resultPath, shareTitle, SITE_ORIGIN } from "./share";
import { formatTime } from "./pipeline";
import type { LookupInput, LookupResult, Match } from "./lookup";

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value: string | number | null | undefined) => String(value ?? "").replace(/[&<>"']/g, (c) => escapes[c]);

const formatDate = (iso: string | null, withYear = true) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { year: withYear ? "numeric" : undefined, month: "short", day: "numeric", timeZone: "UTC" })
    : "";

const WORDS = /[\p{L}\p{N}]+/gu;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const STYLE = `
:root {
  color-scheme: dark;
  /* The creator's hue. renderPage sets both on <html>, and the neutrals take a hue near the accent so they agree with it. */
  --accent-h: 350;
  --tint-h: 300;
  --bg: oklch(0.155 0.012 var(--tint-h));
  --surface: oklch(0.195 0.014 var(--tint-h));
  --surface-2: oklch(0.235 0.016 var(--tint-h));
  --line: oklch(1 0 0 / 0.08);
  --line-strong: oklch(1 0 0 / 0.14);
  --fg: oklch(0.965 0.006 var(--tint-h));
  --muted: oklch(0.71 0.02 var(--tint-h));
  --accent: oklch(0.76 0.17 var(--accent-h));
  --accent-ink: oklch(0.2 0.04 var(--accent-h));
  --accent-soft: oklch(0.76 0.17 var(--accent-h) / 0.14);
  --glow: oklch(0.6 0.2 var(--accent-h) / 0.22);
  --danger: oklch(0.72 0.17 25);
  --shadow: 0 1px 0 oklch(1 0 0 / 0.04) inset, 0 12px 32px -12px oklch(0 0 0 / 0.6);
  --shadow-pop: 0 16px 40px -12px oklch(0 0 0 / 0.6);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: oklch(0.985 0.004 var(--tint-h));
    --surface: oklch(1 0 0);
    --surface-2: oklch(0.965 0.006 var(--tint-h));
    --line: oklch(0.25 0.03 var(--tint-h) / 0.1);
    --line-strong: oklch(0.25 0.03 var(--tint-h) / 0.18);
    --fg: oklch(0.2 0.02 var(--tint-h));
    --muted: oklch(0.47 0.02 var(--tint-h));
    --accent: oklch(0.56 0.2 var(--accent-h));
    --accent-ink: oklch(1 0 0);
    --accent-soft: oklch(0.6 0.2 var(--accent-h) / 0.1);
    --glow: oklch(0.75 0.15 var(--accent-h) / 0.25);
    --danger: oklch(0.53 0.2 25);
    --shadow: 0 1px 2px oklch(0.2 0.02 var(--tint-h) / 0.06), 0 12px 32px -16px oklch(0.2 0.02 var(--tint-h) / 0.25);
    --shadow-pop: 0 16px 40px -16px oklch(0.2 0.02 var(--tint-h) / 0.3);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100dvh; background: var(--bg); color: var(--fg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  background-image: radial-gradient(60rem 28rem at 50% -12rem, var(--glow), transparent 70%);
  background-repeat: no-repeat;
}
a { color: inherit; }
main { max-width: 42rem; margin: 0 auto; padding: clamp(2.5rem, 8vw, 5rem) 1.25rem 4rem; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

h1 { font-size: clamp(2.5rem, 9vw, 3.75rem); line-height: 1; letter-spacing: -0.045em; font-weight: 750; margin: 0 0 .75rem; text-wrap: balance; }
h1 em { font-style: normal; color: var(--accent); }
.pick { position: relative; display: inline-block; }
.pick summary { display: inline-flex; align-items: center; gap: .12em; padding: .07em .2em .09em .09em; border-radius: .3em;
  background: var(--fg); color: var(--bg); cursor: pointer; list-style: none; user-select: none; transform: rotate(-2deg);
  box-shadow: 0 .03em 0 oklch(0 0 0 / .2), 0 .16em .36em -.1em oklch(0 0 0 / .55); transition: transform 200ms var(--ease-out); }
/* The name gives the chip its baseline, so the chip sits on the heading line and not on the bottom of the picture. */
.pick summary .names { align-self: baseline; }
@media (hover: hover) and (pointer: fine) { .pick summary:hover { transform: rotate(-1deg) translateY(-.03em); } }
.pick summary:active { transform: rotate(-1deg) scale(.96); }
.pick[open] summary { transform: none; }
.pick summary::-webkit-details-marker { display: none; }
.pick summary:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }
.face { flex: none; width: .8em; height: .8em; border-radius: 50%; object-fit: cover; background: oklch(0.82 0.1 var(--hue)); }
/* Every name sits in one grid cell, so the pill keeps the widest name's width and the heading does not move. */
.names { display: inline-grid; }
.names > span { grid-area: 1 / 1; }
.names > [aria-hidden] { visibility: hidden; }
.pick summary svg { width: .32em; height: .32em; color: color-mix(in oklch, var(--bg) 55%, transparent); transition: transform 200ms var(--ease-out); }
.pick[open] summary svg { transform: rotate(180deg); }
.menu { position: absolute; z-index: 10; top: calc(100% + .5rem); left: 0; display: grid; gap: 2px; width: max-content; min-width: 15rem; padding: 4px;
  border: 1px solid var(--line-strong); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow), var(--shadow-pop);
  font-size: 1rem; font-weight: 500; line-height: 1.3; letter-spacing: normal; transform-origin: top left;
  transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
@starting-style { .pick[open] .menu { opacity: 0; transform: scale(.96) translateY(-4px); } }
.menu a { display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: .75rem; min-height: 44px; padding: .5rem .75rem;
  border-radius: 10px; color: var(--fg); text-decoration: none; transition: background-color 150ms ease-out; }
.menu a .face { grid-area: 1 / 1 / 3; width: 2rem; height: 2rem; }
.menu a small { grid-area: 2 / 2; font-size: .8125rem; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
.menu a svg { grid-area: 1 / 3 / 3; width: 1rem; height: 1rem; color: var(--accent); }
.menu a:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
@media (hover: hover) and (pointer: fine) { .menu a:hover { background: var(--surface-2); } }
.menu a:active { background: var(--surface-2); transition-duration: 0ms; }
.compact h1 { font-size: clamp(1.75rem, 6vw, 2.25rem); letter-spacing: -0.035em; margin-bottom: 1.25rem; }
.compact .lede { display: none; }
.lede { margin: 0 0 2rem; color: var(--muted); font-size: 1.0625rem; max-width: 34rem; text-wrap: pretty; }

.search { display: grid; gap: .875rem; }
.tabs { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); padding: 4px; margin: 0; border: 1px solid var(--line);
  border-radius: 12px; background: var(--surface); width: min(100%, 24rem); }
.tabs label { position: relative; z-index: 1; padding: .6875rem .5rem; text-align: center; font-size: .9375rem; font-weight: 550;
  color: var(--muted); border-radius: 8px; cursor: pointer; user-select: none; transition: color 200ms ease; }
.tabs input:checked + label { color: var(--fg); }
.tabs input:focus-visible + label { outline: 2px solid var(--fg); outline-offset: 1px; }
.pill { position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 8px) / 3); border-radius: 8px;
  background: var(--surface-2); box-shadow: 0 0 0 1px var(--line-strong), 0 2px 6px -2px oklch(0 0 0 / 0.3);
  transition: transform 220ms var(--ease-out); }
.search:has(#by-post:checked) .pill { transform: translateX(100%); }
.search:has(#by-text:checked) .pill { transform: translateX(200%); }
@media (hover: hover) and (pointer: fine) { .tabs label:hover { color: var(--fg); } }

/* One field box serves all three tabs. The inputs and hints share one grid cell each, so a tab change crossfades only the text,
   and the box, the button and the hint line keep their place. Each input belongs to its own form through the form attribute. */
.entries, .hints { display: grid; flex: 1; min-width: 0; }
.entry, .hints .hint { grid-area: 1 / 1; visibility: hidden; opacity: 0; filter: blur(2px);
  transition: opacity 120ms ease, filter 120ms ease, visibility 0s 120ms; }
.entry { display: flex; align-items: center; }
.search:has(#by-handle:checked) :is(.entry-handle, .hint-handle),
.search:has(#by-post:checked) :is(.entry-post, .hint-post),
.search:has(#by-text:checked) :is(.entry-text, .hint-text) {
  visibility: visible; opacity: 1; filter: none; transition: opacity 180ms ease 40ms, filter 180ms ease 40ms;
}
/* The three buttons look the same, so the swap has no animation. */
.field .go { display: none; }
.search:has(#by-handle:checked) .go-handle, .search:has(#by-post:checked) .go-post, .search:has(#by-text:checked) .go-text { display: block; }
.field { display: flex; align-items: center; gap: .5rem; padding: 6px 6px 6px 1rem; border: 1px solid var(--line-strong);
  border-radius: 14px; background: var(--surface); box-shadow: var(--shadow);
  transition: border-color 160ms ease, box-shadow 160ms ease; }
.field:focus-within { border-color: var(--accent); box-shadow: var(--shadow), 0 0 0 4px var(--accent-soft); }
.field .prefix { color: var(--muted); font-size: 1.0625rem; margin-right: 1px; }
.field input { flex: 1; min-width: 0; padding: .5rem 0; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: 1.0625rem; }
.field input::placeholder { color: var(--muted); opacity: .7; }
.hint { margin: .5rem .25rem 0; font-size: .8125rem; color: var(--muted); }
.hint.error { color: var(--danger); font-weight: 550; }
.field button { position: relative; flex: none; padding: .625rem 1.125rem; border: 0; border-radius: 10px;
  background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 650; cursor: pointer;
  transition: transform 160ms var(--ease-out), filter 160ms ease; }
.field button:active { transform: scale(0.96); }
@media (hover: hover) and (pointer: fine) { .field button:hover { filter: brightness(1.06); } }
.field button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
button .spinner { position: absolute; inset: 0; margin: auto; width: 1em; height: 1em; border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%; visibility: hidden; animation: spin 600ms linear infinite; }
.search[aria-busy="true"] button .spinner { visibility: visible; }
.search[aria-busy="true"] button .label { visibility: hidden; }
.search[aria-busy="true"] button { pointer-events: none; }
@keyframes spin { to { transform: rotate(360deg); } }

.verdict { margin: 3rem 0 1.5rem; animation: rise 320ms var(--ease-out) both; }
.verdict .about { margin: 0 0 .25rem; font-size: .875rem; color: var(--muted); overflow-wrap: anywhere; }
.verdict h2 { margin: 0; font-size: clamp(2.25rem, 8vw, 3rem); line-height: 1.05; letter-spacing: -0.04em; font-weight: 750; }
.verdict.yes h2 { color: var(--accent); }
.verdict p:not(.about) { margin: .5rem 0 0; color: var(--muted); font-size: 1.0625rem; text-wrap: pretty; }
.verdict .switch { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); text-decoration: underline;
  text-underline-offset: 3px; cursor: pointer; }
.notice { margin: 0 0 1rem; padding: .75rem 1rem; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); font-size: .875rem; color: var(--muted); }

.matches { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
.match { overflow: hidden; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); box-shadow: var(--shadow);
  animation: rise 320ms var(--ease-out) both; animation-delay: calc(80ms + min(var(--i), 5) * 40ms); }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
.frame { position: relative; aspect-ratio: 16 / 9; background: var(--surface-2); }
.frame .cover, .frame img { display: block; width: 100%; height: 100%; }
.frame img { object-fit: cover; }
.frame::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(to top, oklch(0 0 0 / 0.55), transparent 45%); }
.chips { position: absolute; z-index: 1; left: .75rem; bottom: .75rem; right: .75rem; display: flex; flex-wrap: wrap; gap: .375rem; }
.chip { display: inline-flex; align-items: center; gap: .375rem; padding: .25rem .625rem; border-radius: 99px; font-size: .8125rem; font-weight: 600;
  font-variant-numeric: tabular-nums; color: white; background: oklch(0 0 0 / 0.55); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.chip.hot { background: var(--accent); color: var(--accent-ink); }
a.chip { position: relative; text-decoration: none; transition: transform 150ms var(--ease-out); }
a.chip:active { transform: scale(0.96); }
a.chip::before { content: ""; position: absolute; inset: -.5rem -.125rem; }
a.chip:focus-visible { outline: 2px solid white; outline-offset: 2px; }
.chip svg { width: .75em; height: .75em; }
.body { padding: 1rem 1.125rem 1.125rem; display: grid; gap: .875rem; }
.video { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem .75rem; }
.video a { font-weight: 650; text-decoration: none; letter-spacing: -0.01em; }
@media (hover: hover) and (pointer: fine) { .video a:hover { text-decoration: underline; text-underline-offset: 3px; } }
.video time { font-size: .8125rem; color: var(--muted); white-space: nowrap; }
.post { display: grid; grid-template-columns: 2.25rem 1fr; gap: .75rem; padding: .875rem; border-radius: 12px; background: var(--surface-2); }
.avatar { width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: .9375rem;
  color: oklch(0.2 0.03 var(--hue)); background: oklch(0.82 0.1 var(--hue)); }
.who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 .375rem; line-height: 1.3; }
.who b { font-weight: 650; }
.who span { color: var(--muted); font-size: .9375rem; }
.badge { align-self: center; padding: .0625rem .5rem; border-radius: 99px; font-size: .75rem; font-weight: 600; color: var(--accent); background: var(--accent-soft); }
.post p { margin: .25rem 0 0; white-space: pre-line; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
mark { background: var(--accent-soft); color: inherit; border-radius: 3px; box-shadow: 0 0 0 1px var(--accent-soft); }
.aloud { margin: 0; padding-left: 1rem; border-left: 2px solid var(--accent); }
.aloud figcaption { font-size: .8125rem; color: var(--muted); }
.aloud blockquote { margin: .25rem 0 0; font-size: 1.0625rem; line-height: 1.5; text-wrap: pretty; }
.aloud blockquote::before { content: "\\201C"; }
.aloud blockquote::after { content: "\\201D"; }
.quiet { margin: 0; font-size: .875rem; color: var(--muted); }

.more { margin-top: 1rem; }
.more > summary { display: flex; align-items: center; justify-content: center; gap: .5rem; min-height: 44px; padding: .5rem 1rem;
  border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); font-weight: 600; cursor: pointer; list-style: none;
  transition: transform 160ms var(--ease-out); }
.more > summary::-webkit-details-marker { display: none; }
.more > summary::after { content: ""; width: .4rem; height: .4rem; border: solid currentColor; border-width: 0 2px 2px 0; transform: translateY(-2px) rotate(45deg);
  transition: transform 200ms var(--ease-out); }
.more[open] > summary::after { transform: translateY(2px) rotate(-135deg); }
.more > summary:active { transform: scale(0.96); }
.more > summary:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.more[open] > summary { margin-bottom: 1rem; }
button, a, input, summary { touch-action: manipulation; }
.share { display: flex; flex-wrap: nowrap; align-items: center; gap: .5rem; margin-top: -.5rem; margin-bottom: 1.5rem; }
.share button, .share a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: .5rem .75rem; white-space: nowrap; border: 1px solid var(--line-strong); border-radius: 10px; background: transparent; color: var(--fg); font: inherit; font-size: .875rem; font-weight: 600; text-decoration: none; cursor: pointer; transition: background-color 150ms ease; }
.share button[data-copy] { min-width: 100px; }
.share .share-primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.share a { border-color: transparent; color: var(--muted); }
.share [hidden] { display: none; }
.share button:focus-visible, .share a:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }
.share button:active, .share a:active { transform: scale(.96); }
@media (hover: hover) and (pointer: fine) { .share [data-copy]:hover { background: var(--surface-2); } .share a:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; } .share .share-primary:hover { filter: brightness(1.08); } }
footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--line); font-size: .8125rem; color: var(--muted); display: grid; gap: .5rem; }
footer p { margin: 0; max-width: 36rem; }

@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 180ms; animation-timing-function: var(--ease-out); }

@media (prefers-reduced-motion: reduce) {
  .pill, .menu, .pick summary, .pick summary svg, .more > summary::after { transition: none; }
  .entry, .hints .hint { filter: none; }
  .verdict, .match { animation-name: fade; }
  @keyframes fade { from { opacity: 0; } }
}
`;

// Only a fine pointer moves focus on tab change: on a phone it would open the keyboard over the page.
const SCRIPT = `const sharing = document.querySelector(".share");
if (sharing) {
  const status = sharing.querySelector(".share-status");
  const copy = sharing.querySelector("[data-copy]");
  const shareButton = sharing.querySelector("[data-share]");
  copy.hidden = Boolean(navigator.share) && matchMedia("(pointer: coarse)").matches;
  const copyLink = async (button) => {
    clearTimeout(button.reset);
    const label = (button.dataset.label ??= button.textContent);
    try {
      await navigator.clipboard.writeText(sharing.dataset.url);
      button.textContent = "✓ Copied";
      status.textContent = "Result link copied.";
      button.reset = setTimeout(() => { button.textContent = label; status.textContent = ""; }, 1500);
    } catch {
      status.classList.remove("sr-only");
      status.textContent = "Copy this link: " + sharing.dataset.url;
    }
  };
  copy.addEventListener("click", () => copyLink(copy));
  shareButton.addEventListener("click", async () => {
    if (!navigator.share) return copyLink(shareButton);
    try { await navigator.share({ title: sharing.dataset.title, text: sharing.dataset.title, url: sharing.dataset.url }); }
    catch (err) { if (err.name !== "AbortError") await copyLink(shareButton); }
  });
}
const search = document.querySelector(".search");
for (const form of document.querySelectorAll("form")) form.addEventListener("submit", () => search.setAttribute("aria-busy", "true"));
let switchingCreator = false;
addEventListener("pageshow", () => {
  search.removeAttribute("aria-busy");
  switchingCreator = false;
});
addEventListener("pageswap", (e) => { if (!switchingCreator) e.viewTransition?.skipTransition(); });
const pick = document.querySelector(".pick");
if (pick) {
  for (const link of pick.querySelectorAll(".menu a")) link.addEventListener("click", () => { switchingCreator = true; });
  document.addEventListener("click", (e) => { if (!pick.contains(e.target)) pick.open = false; });
  pick.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !pick.open) return;
    pick.open = false;
    pick.querySelector("summary").focus();
  });
}
const openTab = (tab) => {
  document.getElementById("by-" + tab).checked = true;
  return document.getElementById(tab);
};
if (matchMedia("(pointer: fine)").matches)
  for (const label of document.querySelectorAll(".tabs label"))
    label.addEventListener("click", () => requestAnimationFrame(() => openTab(label.htmlFor.slice(3)).focus({ preventScroll: true })));
for (const button of document.querySelectorAll("[data-tab]")) button.addEventListener("click", () => openTab(button.dataset.tab).focus());`;

const NEW_TAB = 'target="_blank" rel="noopener noreferrer" aria-describedby="new-tab-hint"';
const PLAY = `<svg viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0v12l10-6z" fill="currentColor"/></svg>`;

/** A text match with at least this share of the query words is shown as a close match. */
const CLOSE_MATCH = 0.75;
const SHOWN = 10;

export type Tab = "handle" | "post" | "text";

export interface SourceRef {
  id: string;
  name: string;
  avatar: string;
  /** OKLCH hue of the page accent. */
  hue: number;
  coverage: LookupResult["coverage"];
}

export interface PageData {
  source: SourceRef;
  sources: SourceRef[];
  input: LookupInput;
  result?: LookupResult;
  error?: string;
}

const tabFor = (input: LookupInput): Tab => (input.q?.trim() ? "text" : input.tweet.trim() && !input.handle.trim() ? "post" : "handle");

const youtube = (videoId: string, seconds: number) =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&amp;t=${Math.floor(seconds)}s`;

/** Wraps the words of `text` that are in `words` with <mark>, escaping everything else. */
function highlight(text: string, words: Set<string>): string {
  if (words.size === 0) return esc(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(WORDS)) {
    out += esc(text.slice(last, m.index));
    out += words.has(m[0].toLowerCase()) ? `<mark>${esc(m[0])}</mark>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function hue(handle: string): number {
  let h = 0;
  for (const c of handle.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const switchTab = (tab: Tab, label: string) => `<button type="button" class="switch" data-tab="${tab}">${label}</button>`;

function verdict(result: LookupResult, close: Match[], loose: Match[]): string {
  const { name } = result.source;
  const { videos, from, to } = result.coverage;
  const about = result.query ? `“${esc(result.query)}”` : `@${esc(result.handle)}`;
  const section = (kind: string, answer: string, detail: string) =>
    `<section class="verdict ${kind}"><p class="about">${about}</p><h2>${answer}</h2><p>${detail}</p></section>`;

  if (close.length === 0) {
    if (loose.length) return section("maybe", "Not exactly.", `No post has most of these words. ${plural(loose.length, "post")} ${loose.length === 1 ? "has" : "have"} some of them.`);
    if (videos === 0) return section("no", "Not yet.", `No ${esc(name)} videos are indexed yet.`);
    const next = result.query
      ? `Try other words, or ${switchTab("handle", "search by handle")}.`
      : `Handle cropped out of the screenshot? ${switchTab("text", "Search by words from the post")}.`;
    return section("no", "Not yet.", `Nothing in the ${plural(videos, "video")} from ${esc(formatDate(from, false))} to ${esc(formatDate(to))}. ${next}`);
  }
  const aloud = close.filter((m) => m.readAloud).length;
  const shown = result.query
    ? `${esc(name)} showed ${plural(close.length, "post")} with that text`
    : `${esc(name)} showed your posts ${plural(close.reduce((sum, m) => sum + m.times.length, 0), "time")}`;
  const read = aloud === 0 ? ", but did not read them aloud." : aloud === close.length && aloud > 1 ? " and read every one aloud." : ` and read ${aloud} aloud.`;
  return section("yes", "Yes.", shown + read);
}

function card(m: Match, i: number, words: Set<string>, sourceName: string, eager: boolean): string {
  const name = m.displayName || m.handle.replace(/^@/, "");
  const chips = [
    ...m.times.map(
      (t, n) =>
        `<a class="chip" ${NEW_TAB} href="${youtube(m.videoId, t)}">${n === 0 ? `${PLAY} On screen ` : `<span class="sr-only">Also on screen at </span>`}${formatTime(t)}</a>`,
    ),
    m.readAloud ? `<a class="chip hot" ${NEW_TAB} href="${youtube(m.videoId, m.readAloud.at)}">Read aloud ${formatTime(m.readAloud.at)}</a>` : "",
  ].join("");
  const aloud = m.readAloud
    ? `<figure class="aloud">
<figcaption>${esc(sourceName)} read it aloud at <a ${NEW_TAB} href="${youtube(m.videoId, m.readAloud.at)}">${formatTime(m.readAloud.at)}</a></figcaption>
${m.readAloud.quote ? `<blockquote>${esc(m.readAloud.quote)}</blockquote>` : ""}
</figure>`
    : `<p class="quiet">${m.times.length > 1 ? `Shown on screen ${m.times.length} times` : `Shown on screen for about ${Math.max(5, Math.round(m.lastSeen - m.firstSeen))} seconds`}. Not read aloud.</p>`;
  return `<li class="match" id="mention-${esc(m.videoId)}-${m.firstSeen}" style="--i:${i}">
<div class="frame">
<a class="cover" ${NEW_TAB} href="${youtube(m.videoId, m.firstSeen)}" tabindex="-1" aria-hidden="true"><img src="${esc(m.frameUrl)}" alt="" loading="${eager && i < 2 ? "eager" : "lazy"}" decoding="async"></a>
<span class="chips">${chips}</span>
</div>
<div class="body">
<div class="video"><a ${NEW_TAB} href="${youtube(m.videoId, m.firstSeen)}">${esc(m.title ?? m.videoId)}</a><time datetime="${esc(m.publishedAt)}">${esc(formatDate(m.publishedAt))}</time></div>
<div class="post">
<div class="avatar" style="--hue:${hue(m.handle)}" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</div>
<div><div class="who"><b>${esc(name)}</b><span>${esc(m.handle)}</span>${m.exact ? '<span class="badge">Your post</span>' : ""}</div>
<p>${highlight(m.text, words)}</p></div>
</div>
${aloud}
</div>
</li>`;
}

const more = (summary: string, body: string, open = false) =>
  `<details class="more"${open ? " open" : ""}><summary>${summary}</summary>${body}</details>`;

function results(result: LookupResult): string {
  const words = new Set(result.query ? result.query.toLowerCase().match(WORDS) : []);
  const isClose = (m: Match) => !result.query || (m.overlap ?? 0) >= CLOSE_MATCH;
  const close = result.matches.filter(isClose);
  const loose = result.matches.filter((m) => !isClose(m));
  const cards = (list: Match[], eager = false) =>
    `<ol class="matches">${list.map((m, i) => card(m, i, words, result.source.name, eager)).join("\n")}</ol>`;
  const notices = [
    result.tweet ? `<p class="notice">Searched for the post by @${esc(result.tweet.handle)}: “${esc(result.tweet.text)}”</p>` : "",
    result.tweetError ? `<p class="notice">${esc(result.tweetError)}</p>` : "",
  ].join("");
  return [
    verdict(result, close, loose),
    notices,
    close.length ? cards(close.slice(0, SHOWN), true) : "",
    close.length > SHOWN ? more(`Show ${close.length - SHOWN} more`, cards(close.slice(SHOWN))) : "",
    loose.length ? more(`${plural(loose.length, "post")} with some of these words`, cards(loose, close.length === 0), close.length === 0) : "",
  ].join("\n");
}

function shareControls(url: string, title: string): string {
  return `<div class="share" data-url="${esc(url)}" data-title="${esc(title)}">
<button type="button" class="share-primary" data-share>Share result</button>
<button type="button" data-copy>Copy link</button>
<a href="https://x.com/intent/post?${esc(new URLSearchParams({ text: `${title} Found the receipts.`, url }).toString())}" target="_blank" rel="noopener noreferrer" aria-describedby="new-tab-hint">Post on X ↗</a>
<span class="share-status sr-only" role="status" aria-live="polite"></span>
</div>`;
}

const tab = (id: Tab, label: string, active: Tab) =>
  `<input class="sr-only" type="radio" name="by" id="by-${id}" value="${id}"${id === active ? " checked" : ""}><label for="by-${id}">${label}</label>`;

interface Entry {
  id: Tab;
  label: string;
  attrs: string;
  hint: string;
  prefix?: string;
}

/** The field box with every tab's input. A lookup error replaces the hint of the active tab, next to the field it is about. */
function field(entries: Entry[], data: PageData, active: Tab): string {
  const error = (id: Tab) => (id === active ? data.error : undefined);
  const forms = entries.map(({ id }) =>
    `<form id="f-${id}" method="get" action="/"><input type="hidden" name="source" value="${esc(data.source.id)}"></form>`);
  const inputs = entries.map(({ id, label, attrs, prefix = "" }) => `<span class="entry entry-${id}"><label class="sr-only" for="${id}">${label}</label>${prefix}
<input id="${id}" form="f-${id}" ${attrs} autocomplete="off" aria-describedby="${id}-hint"${error(id) ? ' aria-invalid="true"' : ""}></span>`);
  const buttons = entries.map(({ id }) =>
    `<button class="go go-${id}" type="submit" form="f-${id}"><span class="label">Check</span><span class="spinner" aria-hidden="true"></span></button>`);
  const hints = entries.map(({ id, hint }) => {
    const e = error(id);
    return `<p class="hint hint-${id}${e ? " error" : ""}" id="${id}-hint"${e ? ' role="alert"' : ""}>${esc(e ?? hint)}</p>`;
  });
  return `<div>${forms.join("")}
<div class="field"><span class="entries">${inputs.join("\n")}</span>${buttons.join("")}</div>
<div class="hints">${hints.join("\n")}</div></div>`;
}

const CHEVRON = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const face = ({ id, avatar }: SourceRef) =>
  `<img class="face" src="${esc(avatar)}" alt="" width="96" height="96" referrerpolicy="no-referrer" style="--hue:${hue(id)}">`;

function creatorPicker({ source, sources, input }: PageData): string {
  if (sources.length < 2) return esc(source.name);
  const names = sources.map((s) => `<span${s.id === source.id ? "" : ' aria-hidden="true"'}>${esc(s.name)}</span>`);
  const items = sources.map((s) => {
    const { id, name, coverage: c } = s;
    const meta = c.videos ? `${plural(c.videos, "video")} · ${esc(formatDate(c.from, false))} to ${esc(formatDate(c.to, false))}` : "First videos in progress";
    const current = id === source.id;
    return `<a href="${esc(resultPath(input, id))}"${current ? ' aria-current="page"' : ""}>${face(s)}${esc(name)}<small>${meta}</small>${current ? CHECK : ""}</a>`;
  });
  return `<details class="pick"><summary>${face(source)}<span class="names">${names.join("")}</span>${CHEVRON}</summary>
<nav class="menu" aria-label="Creators">${items.join("")}</nav></details>`;
}

export function renderPage(data: PageData): string {
  const { input } = data;
  const active = tabFor(input);
  const name = esc(data.source.name);
  const title = shareTitle(data.source.name, data.result);
  const path = resultPath(input, data.source.id);
  const canonical = SITE_ORIGIN + path;
  const image = SITE_ORIGIN + "/og.png" + path.slice(1);
  const description = `Find the exact moments ${data.source.name} showed X posts on screen, with video frames and links to each second.`;
  return `<!doctype html>
<html lang="en" style="--accent-h:${data.source.hue};--tint-h:${data.source.hue - 50}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0e0c12" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fbf9fb" media="(prefers-color-scheme: light)">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)} Video moments, with receipts.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="description" content="Find out if ${name} showed or read your X post in a video.">
<style>${STYLE}</style>
</head>
<body>
<main${data.result || data.error ? ' class="compact"' : ""}>
<h1>Did ${creatorPicker(data)} mention <em>me?</em></h1>
<p class="lede">We scan every video for X posts on screen, then check the transcript to see if they were read aloud.</p>

<div class="search">
<fieldset class="tabs"><legend class="sr-only">Search by</legend>
${tab("handle", "Handle", active)}
${tab("post", "Post link", active)}
${tab("text", "Text", active)}
<span class="pill" aria-hidden="true"></span>
</fieldset>

${field(
  [
    {
      id: "handle",
      label: "X handle",
      attrs: `name="handle" value="${esc(input.handle.replace(/^@/, ""))}" placeholder="yourhandle" autocapitalize="off" spellcheck="false" required`,
      hint: "Every post with your handle on screen. A profile or post link works too.",
      prefix: `<span class="prefix" aria-hidden="true">@</span>`,
    },
    {
      id: "post",
      label: "Post URL",
      attrs: `name="tweet" value="${esc(input.tweet)}" placeholder="https://x.com/you/status/…" inputmode="url" spellcheck="false" required`,
      hint: "Matches the text of one post, even if the handle was cropped out.",
    },
    {
      id: "text",
      label: "Words from the post",
      attrs: `name="q" value="${esc(input.q ?? "")}" placeholder="haiku vs luna reasoning" required pattern="\\s*\\S+\\s+\\S.*" title="Enter at least two words."`,
      hint: "A few words you remember. Matches by words and by meaning.",
    },
  ],
  data,
  active,
)}
</div>

${data.result ? results(data.result).replace('</section>', `</section>${shareControls(canonical, title)}`) : ""}
<span class="sr-only" id="new-tab-hint">Opens in a new tab.</span>

<footer>
<p>An image model looks for X posts in the frames of each video. A second model reads them, and the transcript shows if ${name} read them aloud. Results can miss posts or misread a handle.</p>
<p>Not affiliated with ${name}.</p>
</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
