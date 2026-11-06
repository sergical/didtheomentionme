import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import font from "./assets/inter.bin";
import { getSource } from "./config";
import type { Env } from "./env";
import { LookupError, lookup } from "./lookup";
import type { LookupResult, Match } from "./lookup";
import { formatTime } from "./pipeline";
import { largeFrame } from "./retention";
import { resultPath } from "./share";

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const cut = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s;
let ready: Promise<void> | undefined;

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#17131c"/><path d="M26 32h128v94H100l-40 30v-30H26z" fill="#f58fb1" stroke="#f58fb1" stroke-width="14" stroke-linejoin="round"/><path d="m72 46 54 33-54 33z" fill="#17131c" stroke="#17131c" stroke-width="6" stroke-linejoin="round"/></svg>`;

async function png(svg: string, width = 1200): Promise<Uint8Array> {
  await (ready ??= initWasm(wasm));
  const renderer = new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { fontBuffers: [new Uint8Array(font)], defaultFontFamily: "Inter" } });
  try {
    const image = renderer.render();
    try { return image.asPng().slice(); } finally { image.free(); }
  } finally { renderer.free(); }
}

const dataUrl = (buffer: ArrayBuffer, type: string) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
};

async function frameImage(env: Env, match?: Match): Promise<string> {
  if (!match) return "";
  const path = match.frameUrl.match(/^\/frame\/([\w-]+)\/(\d+)\.jpg$/);
  if (!path) return "";
  const object = await largeFrame(env.BUCKET, path[1], path[2]);
  return object ? dataUrl(await object.arrayBuffer(), "image/jpeg") : "";
}

async function avatarImage(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), cf: { cacheTtl: 86400 } });
    return response.ok ? dataUrl(await response.arrayBuffer(), "image/jpeg") : "";
  } catch { return ""; }
}

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

function imageSvg(name: string, accent: string, result: LookupResult | undefined, frame: string, avatar: string): string {
  const matches = result?.matches.filter((m) => !result.query || (m.overlap ?? 0) >= 0.75) ?? [];
  const first = matches[0];
  const count = matches.reduce((sum, m) => sum + m.times.length, 0);
  const subject = result?.query ? `“${cut(result.query, 24)}”` : `@${result?.handle ?? "you"}`;
  const pill = first ? `▶ ${formatTime(first.firstSeen)} · On screen` : result ? "Not on screen yet" : "▶ 12:34 · On screen";
  const pillY = frame ? 386 : 366;
  const left = result
    ? `<text x="128" y="91" font-size="25">Did ${xml(name)} mention me?</text>
<text x="60" y="214" font-size="${subject.length > 19 ? 36 : 48}"${subject.length > 10 ? ' textLength="480" lengthAdjust="spacingAndGlyphs"' : ""} fill="${accent}">${xml(subject)}</text>
<text x="60" y="295" font-size="56">${count ? "On screen." : "Not yet."}</text>
<text x="60" y="370" font-size="56">${count ? "Receipts inside." : "Still watching."}</text>
<text x="62" y="434" font-size="23" fill="#c4b9c9">${count ? `${xml(name)} put you on screen ${count === 1 ? "once" : `${count} times`}.` : "Search the latest indexed videos."}</text>
<path d="M60 522h1080" stroke="#403445"/>
<text x="60" y="575" font-size="22" fill="#c4b9c9">didtheomentionme</text>
<text x="1140" y="575" text-anchor="end" font-size="22" fill="${accent}">${first?.readAloud && first.readAloud.reading !== "comment" ? "Shown. Read aloud. Found." : "Find the moment. Keep the receipt."}</text>`
    : `<text x="128" y="91" font-size="24" fill="#c4b9c9">didtheomentionme</text>
<text x="60" y="318" font-size="84" letter-spacing="-3">Did ${xml(name)}</text>
<text x="60" y="408" font-size="84" letter-spacing="-3">mention <tspan fill="${accent}">me?</tspan></text>
<text x="62" y="490" font-size="26" fill="#c4b9c9">Paste your X handle. Get the exact second.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><clipPath id="frame"><rect x="594" y="142" width="550" height="310" rx="22"/></clipPath><clipPath id="face"><circle cx="88" cy="82" r="25"/></clipPath></defs>
<rect width="1200" height="630" fill="#17131c"/>
<path d="M0 0h1200v8H0z" fill="${accent}"/>
<circle cx="88" cy="82" r="25" fill="${accent}"/>${avatar ? `<image x="63" y="57" width="50" height="50" href="${avatar}" clip-path="url(#face)"/>` : ""}
<g font-family="Inter" font-weight="700" fill="#faf5fa">
${left}
<g transform="translate(0 ${result ? 0 : 56})">
<rect x="594" y="142" width="550" height="310" rx="22" fill="#27212e" stroke="#46394a"/>
${frame ? `<image x="594" y="142" width="550" height="310" preserveAspectRatio="xMidYMid slice" href="${frame}" clip-path="url(#frame)"/>` : mockFrame(accent, result?.query ? "@you" : subject, !result || Boolean(first))}
<rect x="618" y="${pillY}" width="${Math.round(44 + [...pill].length * 9.6)}" height="42" rx="21" fill="${accent}"/>
<text x="639" y="${pillY + 28}" font-size="20" fill="#241820">${xml(pill)}</text>
</g>
</g></svg>`;
}

export async function socialImage(env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname === "/favicon.svg") return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } });
  const source = getSource(url.searchParams.get("source"));
  if (!source) return new Response("unknown source", { status: 400 });
  const input = { handle: url.searchParams.get("handle") ?? "", tweet: url.searchParams.get("tweet") ?? "", q: url.searchParams.get("q") ?? "", source: source.id };
  if (input.handle.length > 512 || input.tweet.length > 2048 || input.q.length > 512) return new Response("query too long", { status: 400 });
  const key = new Request(`${url.origin}${url.pathname}${resultPath(input, source.id).slice(1)}&v=8`);
  const cache = await caches.open("social-v8");
  const cached = await cache.match(key);
  if (cached) return cached;
  const apple = url.pathname === "/apple-touch-icon.png";
  let result: LookupResult | undefined;
  if (!apple && (input.handle.trim() || input.tweet.trim() || input.q.trim())) {
    try { result = await lookup(env, input); }
    catch (err) { if (err instanceof LookupError) return new Response(err.message, { status: 400 }); throw err; }
  }
  const first = result?.matches.find((m) => !result?.query || (m.overlap ?? 0) >= 0.75);
  const [frame, avatar] = apple ? ["", ""] : await Promise.all([frameImage(env, first), avatarImage(source.avatar)]);
  const bytes = await png(apple ? FAVICON : imageSvg(source.name, source.id === "prime" ? "#ffa766" : "#f58fb1", result, frame, avatar), apple ? 180 : 1200);
  const response = new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "image/png", "cache-control": `public, max-age=${result ? 3600 : 86400}` } });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
