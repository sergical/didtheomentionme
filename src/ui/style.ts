/** The page styles. The lookup page uses STYLE; the explore page adds EXPLORE_STYLE. */

export const STYLE = `
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
a.frame { display: block; aspect-ratio: 16 / 9; background: var(--surface-2); }
.frame img { display: block; width: 100%; height: 100%; object-fit: cover; }
.body { padding: 1rem 1.125rem 1.125rem; display: grid; gap: .875rem; }
.video { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem .75rem; }
.video a { font-weight: 650; text-decoration: none; letter-spacing: -0.01em; }
@media (hover: hover) and (pointer: fine) { .video a:hover { text-decoration: underline; text-underline-offset: 3px; } }
.video time { font-size: .8125rem; color: var(--muted); white-space: nowrap; }
.avatar { width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: .9375rem;
  color: oklch(0.2 0.03 var(--hue)); background: oklch(0.82 0.1 var(--hue)); }
.who { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 .375rem; line-height: 1.3; }
.who b { font-weight: 650; }
.who span { color: var(--muted); font-size: .9375rem; }
.badge { align-self: center; padding: .0625rem .5rem; border-radius: 99px; font-size: .75rem; font-weight: 600; color: var(--accent); background: var(--accent-soft); }
mark { background: var(--accent-soft); color: inherit; border-radius: 3px; box-shadow: 0 0 0 1px var(--accent-soft); }
.quiet { margin: 0; font-size: .875rem; color: var(--muted); }
.excerpt { margin: 0; font-size: .9375rem; color: var(--muted); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.said { margin: 0; padding-left: 1rem; border-left: 2px solid var(--accent); }
.said blockquote { margin: 0; font-size: 1.1875rem; line-height: 1.45; letter-spacing: -0.01em; text-wrap: pretty; }
.said blockquote::before { content: "\\201C"; }
.said blockquote::after { content: "\\201D"; }
.said.comment { border-left-color: var(--line-strong); }
.said.comment blockquote { font-size: 1rem; line-height: 1.5; letter-spacing: 0; color: var(--muted); }
.said figcaption { margin-top: .375rem; font-size: .875rem; color: var(--muted); }
.said figcaption::before { content: "\\2014\\00A0"; }
.said a, .quiet a { color: inherit; font-variant-numeric: tabular-nums; text-underline-offset: 3px; }
.times { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .375rem; font-size: .8125rem; color: var(--muted); }
.times > span:first-child { margin-right: .125rem; }
.times .badge { margin-left: auto; }
.chip { position: relative; display: inline-flex; align-items: center; gap: .375rem; min-height: 1.75rem; padding: .25rem .625rem; border-radius: 99px;
  font-size: .8125rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--fg); background: var(--surface-2); text-decoration: none;
  transition: transform 150ms var(--ease-out); }
.chip:active { transform: scale(0.96); }
.chip::before { content: ""; position: absolute; inset: -.5rem -.125rem; }
.chip:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.chip svg { width: .75em; height: .75em; }
@media (hover: hover) and (pointer: fine) { .chip { transition-property: transform, background-color; } .chip:hover { background: var(--line); } }

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

export const EXPLORE_STYLE = `
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

/* One column for each tenth of a video, as in exploreData. */
.hist { display: grid; grid-template-columns: repeat(10, 1fr); align-items: end; gap: 2px; height: 11rem; padding: 1.75rem 0 0;
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
