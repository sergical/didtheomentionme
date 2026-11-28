/** The social preview image as SVG text. Pure, so it needs no PNG renderer and no bindings. */
import type { LookupResult, Match } from "./lookup";
import { formatTime } from "./pipeline";

/** A text match with at least this share of the query words counts as the post. */
const CLOSE_MATCH = 0.75;

/** The matches a card counts and shows: every match of a handle search, and the close ones of a text search. */
export const closeMatches = (result: LookupResult | undefined): Match[] =>
  result?.matches.filter((m) => !result.query || (m.overlap ?? 0) >= CLOSE_MATCH) ?? [];

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const cut = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s;

const mockFrame = (accent: string, handle: string, found: boolean) => `<g transform="rotate(-4 869 262)">
<rect x="719" y="192" width="300" height="140" rx="18" fill="#faf5fa"/>
<circle cx="759" cy="232" r="20" fill="#d9cfdc"/>
<text x="791" y="243" font-size="${[...handle].length > 11 ? 22 : 28}" fill="#17131c">${xml(handle)}</text>
<rect x="743" y="274" width="252" height="12" rx="6" fill="#d9cfdc"/>
<rect x="743" y="298" width="172" height="12" rx="6" fill="#d9cfdc"/>
</g>
<rect x="618" y="432" width="502" height="6" rx="3" fill="#46394a"/>
${found ? `<rect x="618" y="432" width="312" height="6" rx="3" fill="${accent}"/>
<circle cx="930" cy="435" r="10" fill="${accent}"/>` : ""}`;

/** What one card shows. */
export interface SocialCard {
  /** The creator's name. */
  name: string;
  accent: string;
  /** No result makes the card of the site itself. */
  result: LookupResult | undefined;
  /** The frame and the creator's picture as data URLs, or "" for none. */
  frame: string;
  avatar: string;
}

const NOT_SHOWN = { answer: "Not yet.", next: "Still watching.", detail: "Search the latest indexed videos." };

const shown = (name: string, count: number) =>
  ({ answer: "On screen.", next: "Receipts inside.", detail: `${xml(name)} put you on screen ${count === 1 ? "once" : `${count} times`}.` });

/** The left column of a result's card: who was searched for, and whether the creator showed them. */
function resultText({ name, accent }: SocialCard, subject: string, matches: Match[]): string {
  const count = matches.reduce((sum, m) => sum + m.times.length, 0);
  const { answer, next, detail } = count ? shown(name, count) : NOT_SHOWN;
  const fit = subject.length > 10 ? ' textLength="480" lengthAdjust="spacingAndGlyphs"' : "";
  const reading = matches[0]?.readAloud?.reading;
  const tagline = reading && reading !== "comment" ? "Shown. Read aloud. Found." : "Find the moment. Keep the receipt.";

  return `<text x="128" y="91" font-size="25">Did ${xml(name)} mention me?</text>
<text x="60" y="214" font-size="${subject.length > 19 ? 36 : 48}"${fit} fill="${accent}">${xml(subject)}</text>
<text x="60" y="295" font-size="56">${answer}</text>
<text x="60" y="370" font-size="56">${next}</text>
<text x="62" y="434" font-size="23" fill="#c4b9c9">${detail}</text>
<path d="M60 522h1080" stroke="#403445"/>
<text x="60" y="575" font-size="22" fill="#c4b9c9">didtheomentionme</text>
<text x="1140" y="575" text-anchor="end" font-size="22" fill="${accent}">${tagline}</text>`;
}

/** The left column of the site's own card. */
const siteText = ({ name, accent }: SocialCard) => `<text x="128" y="91" font-size="24" fill="#c4b9c9">didtheomentionme</text>
<text x="60" y="318" font-size="84" letter-spacing="-3">Did ${xml(name)}</text>
<text x="60" y="408" font-size="84" letter-spacing="-3">mention <tspan fill="${accent}">me?</tspan></text>
<text x="62" y="490" font-size="26" fill="#c4b9c9">Paste your X handle. Get the exact second.</text>`;

/** The right column: the video frame, or a drawing of one, under a pill with the time the post was on screen. */
function frameArea({ accent, result, frame }: SocialCard, subject: string, first: Match | undefined): string {
  const notFound = result ? "Not on screen yet" : "▶ 12:34 · On screen";
  const pill = first ? `▶ ${formatTime(first.firstSeen)} · On screen` : notFound;
  const pillY = frame ? 386 : 366;

  const picture = frame
    ? `<image x="594" y="142" width="550" height="310" preserveAspectRatio="xMidYMid slice" href="${frame}" clip-path="url(#frame)"/>`
    : mockFrame(accent, result?.query ? "@you" : subject, !result || Boolean(first));

  return `<rect x="594" y="142" width="550" height="310" rx="22" fill="#27212e" stroke="#46394a"/>
${picture}
<rect x="618" y="${pillY}" width="${Math.round(44 + [...pill].length * 9.6)}" height="42" rx="21" fill="${accent}"/>
<text x="639" y="${pillY + 28}" font-size="20" fill="#241820">${xml(pill)}</text>`;
}

export function cardSvg(card: SocialCard): string {
  const { accent, result, avatar } = card;
  const matches = closeMatches(result);
  const subject = result?.query ? `“${cut(result.query, 24)}”` : `@${result?.handle ?? "you"}`;
  const face = avatar ? `<image x="63" y="57" width="50" height="50" href="${avatar}" clip-path="url(#face)"/>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><clipPath id="frame"><rect x="594" y="142" width="550" height="310" rx="22"/></clipPath><clipPath id="face"><circle cx="88" cy="82" r="25"/></clipPath></defs>
<rect width="1200" height="630" fill="#17131c"/>
<path d="M0 0h1200v8H0z" fill="${accent}"/>
<circle cx="88" cy="82" r="25" fill="${accent}"/>${face}
<g font-family="Inter" font-weight="700" fill="#faf5fa">
${result ? resultText(card, subject, matches) : siteText(card)}
<g transform="translate(0 ${result ? 0 : 56})">
${frameArea(card, subject, matches[0])}
</g>
</g></svg>`;
}
