import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import font from "./assets/inter.bin";
import { getSource, type Source } from "./config";
import { Effect, Result } from "effect";
import { lookup } from "./lookup";
import { httpFetch, span, type App } from "./runtime";
import type { LookupInput, LookupResult, Match } from "./lookup";
import { cardSvg, closeMatches } from "./social-card";
import { largeFrame } from "./retention";
import { resultPath } from "./share";

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

const frameImage = (match?: Match) =>
  Effect.gen(function* () {
    const path = match?.frameUrl.match(/^\/frame\/([\w-]+)\/(\d+)\.jpg$/);

    if (!path) return "";
    const object = yield* largeFrame(path[1], path[2]);

    return object ? dataUrl(yield* Effect.promise(() => object.arrayBuffer()), "image/jpeg") : "";
  });

const avatarImage = (url: string) =>
  httpFetch(url, { signal: AbortSignal.timeout(2000), cf: { cacheTtl: 86400 } }).pipe(
    Effect.flatMap((response) => (response.ok ? Effect.promise(() => response.arrayBuffer()).pipe(Effect.map((b) => dataUrl(b, "image/jpeg"))) : Effect.succeed(""))),
    Effect.catchCause(() => Effect.succeed("")),
  );

/** The PNG of one SVG, as a response browsers and X may keep for `maxAge` seconds. */
const pngResponse = (svg: string, width: number, maxAge: number) =>
  Effect.map(
    Effect.promise(() => png(svg, width)).pipe(span("render png", "function")),
    (bytes) => new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "image/png", "cache-control": `public, max-age=${maxAge}` } }),
  );

/** The preview card of a search, or of the site when the URL names no search. A bad search answers 400. */
const cardImage = (source: Source, input: LookupInput) =>
  Effect.gen(function* () {
    let result: LookupResult | undefined;

    if (input.handle.trim() || input.tweet.trim() || input.q?.trim()) {
      const found = yield* Effect.result(lookup(input));

      if (Result.isFailure(found)) return new Response(found.failure.message, { status: 400 });
      result = found.success;
    }

    const [frame, avatar] = yield* Effect.all([frameImage(closeMatches(result)[0]), avatarImage(source.avatar)], { concurrency: 2 });
    const accent = source.id === "prime" ? "#ffa766" : "#f58fb1";

    return yield* pngResponse(cardSvg({ name: source.name, accent, result, frame, avatar }), 1200, result ? 3600 : 86400);
  });

const tooLong = (input: LookupInput) => input.handle.length > 512 || input.tweet.length > 2048 || (input.q ?? "").length > 512;

export const socialImage = (url: URL, waitUntil: (promise: Promise<unknown>) => void): Effect.Effect<Response, never, App> =>
  Effect.gen(function* () {
    if (url.pathname === "/favicon.svg") return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } });
    const source = getSource(url.searchParams.get("source"));

    if (!source) return new Response("unknown source", { status: 400 });
    const input = { handle: url.searchParams.get("handle") ?? "", tweet: url.searchParams.get("tweet") ?? "", q: url.searchParams.get("q") ?? "", source: source.id };

    if (tooLong(input)) return new Response("query too long", { status: 400 });
    const key = new Request(`${url.origin}${url.pathname}${resultPath(input, source.id).slice(1)}&v=8`);
    const cache = yield* Effect.promise(() => caches.open("social-v8"));
    const cached = yield* Effect.promise(() => cache.match(key));

    if (cached) return cached;
    const response = yield* (url.pathname === "/apple-touch-icon.png" ? pngResponse(FAVICON, 180, 86400) : cardImage(source, input));

    if (response.ok) waitUntil(cache.put(key, response.clone()));

    return response;
  });
