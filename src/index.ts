import { Cause, Effect, Result } from "effect";
import { authorized } from "./auth";
import { DEFAULT_SOURCE, SOURCES, getSource } from "./config";
import type { Env } from "./env";
import { exploreData } from "./explore";
import { coverage, lookup } from "./lookup";
import { expireFrames, largeFrame } from "./retention";
import { annotate, r2, runApp, span, type App } from "./runtime";
import { socialImage } from "./social";
import type { PageData } from "./ui/model";
import { renderExplore, renderPage } from "./ui/render";
import { Telemetry, errorMessage } from "./telemetry";
import { backfill, destroyContainer, discoverRss, processNow, startPending } from "./videos";

export { ContainerProxy } from "@cloudflare/containers";

export { MediaContainer } from "./container";

export { VideoWorkflow } from "./workflow";

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

const frame = (videoId: string, second: string, size: "f640" | "f1920") =>
  Effect.gen(function* () {
    const smallKey = `videos/${videoId}/f640/${second}.jpg`;
    const object = size === "f640" ? yield* r2("GetObject", smallKey, (bucket) => bucket.get(smallKey)) : yield* largeFrame(videoId, second);

    if (!object) return new Response("not found", { status: 404 });

    return new Response(object.body, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=604800", etag: object.httpEtag } });
  });

const admin = (url: URL) =>
  Effect.gen(function* () {
    const source = getSource(url.searchParams.get("source"));

    if (!source) return Response.json({ error: "unknown source" }, { status: 400 });

    if (url.pathname === "/admin/backfill") {
      const days = Number(url.searchParams.get("days") ?? 30);

      if (!Number.isFinite(days) || days <= 0) return Response.json({ error: "bad days" }, { status: 400 });

      return Response.json(yield* backfill(source, days));
    }

    const videoId = url.searchParams.get("v") ?? "";

    if (!VIDEO_ID.test(videoId)) return Response.json({ error: "bad v" }, { status: 400 });

    if (url.pathname === "/admin/reset") {
      yield* destroyContainer(videoId);

      return Response.json({ videoId, result: "destroyed" });
    }

    return Response.json({ videoId, result: yield* processNow(videoId, source.id) });
  });

// Pages fall back to the default creator for an unknown `source`.
const pageSourceId = (requested: string | null) => (getSource(requested) ?? getSource(DEFAULT_SOURCE)!).id;

const pageSources = (requested: string | null) =>
  Effect.gen(function* () {
    const id = pageSourceId(requested);
    const sources = yield* Effect.forEach(SOURCES, (s) => Effect.map(coverage(s.id), (c) => ({ id: s.id, name: s.name, avatar: s.avatar, hue: s.hue, coverage: c })), { concurrency: "unbounded" });

    return { source: sources.find((s) => s.id === id)!, sources };
  });

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const searchInput = (url: URL) =>
  ({ handle: url.searchParams.get("handle") ?? "", tweet: url.searchParams.get("tweet") ?? "", q: url.searchParams.get("q") ?? "", source: url.searchParams.get("source") });

const isEmpty = (input: ReturnType<typeof searchInput>) => !input.handle.trim() && !input.tweet.trim() && !input.q.trim();

/** `/api/lookup`: the result of a search, as JSON. */
const lookupApi = (url: URL) =>
  Effect.gen(function* () {
    const input = searchInput(url);

    if (isEmpty(input)) return Response.json({ error: "handle, tweet or q is required" }, { status: 400 });
    const result = yield* Effect.result(lookup(input));

    return Result.isSuccess(result) ? Response.json(result.success) : Response.json({ error: result.failure.message }, { status: 400 });
  });

/** `/`: the lookup page, with the result or the error of the search in its URL. */
const lookupPage = (url: URL) =>
  Effect.gen(function* () {
    const input = searchInput(url);
    const pageInput = { ...input, source: pageSourceId(input.source) };
    // The picker's counts and the lookup need nothing from each other, so they run at once.
    const [{ source, sources }, result] = yield* Effect.all([pageSources(input.source), isEmpty(input) ? Effect.succeed(undefined) : Effect.result(lookup(pageInput))], { concurrency: 2 });
    const page = { source, sources, input: pageInput };
    const render = (data: PageData, status = 200) => Effect.map(renderPage(data).pipe(span("render page", "ui.render")), (body) => html(body, status));

    if (!result) return yield* render(page);

    return yield* (Result.isSuccess(result) ? render({ ...page, result: result.success }) : render({ ...page, error: result.failure.message }, 400));
  });

const exploreRoute = (url: URL) =>
  Effect.gen(function* () {
    const requested = url.searchParams.get("source");
    const sort = url.searchParams.get("sort") === "posts" ? "posts" : "newest";
    // The picker's counts and the page's numbers need nothing from each other, so they run at once.
    const [{ source, sources }, data] = yield* Effect.all([pageSources(requested), exploreData(pageSourceId(requested), sort)], { concurrency: 2 });

    return html(yield* renderExplore({ ...data, source, sources }).pipe(span("render explore page", "ui.render")));
  });

/** The route a request goes to, and the Effect that answers it. */
function route(request: Request, env: Env, url: URL, waitUntil: (p: Promise<unknown>) => void): [string, Effect.Effect<Response, unknown, App>] {
  const { pathname } = url;

  if (pathname.startsWith("/admin/")) {
    return [pathname, Effect.gen(function* () {
      if (!(yield* Effect.promise(() => authorized(request, env)))) return new Response("unauthorized", { status: 401 });

      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

      if (["/admin/backfill", "/admin/process", "/admin/reset"].includes(pathname)) return yield* admin(url);

      return new Response("not found", { status: 404 });
    })];
  }

  if (request.method !== "GET" && request.method !== "HEAD") return [pathname, Effect.succeed(new Response("method not allowed", { status: 405 }))];

  if (["/og.png", "/favicon.svg", "/apple-touch-icon.png"].includes(pathname)) return [pathname, socialImage(url, waitUntil)];
  const frameMatch = pathname.match(/^\/frame\/([A-Za-z0-9_-]+)\/(\d+)\.jpg$/);

  if (frameMatch) return ["/frame/:videoId/:second.jpg", frame(frameMatch[1], frameMatch[2], url.searchParams.get("size") === "640" ? "f640" : "f1920")];

  if (pathname === "/") return [pathname, lookupPage(url)];

  if (pathname === "/api/lookup") return [pathname, lookupApi(url)];

  if (pathname === "/explore") return [pathname, exploreRoute(url)];

  return ["/*", Effect.succeed(new Response("not found", { status: 404 }))];
}

/** An error that escapes the handler is reported, then thrown, so the Worker answers 500. Use it inside the span. */
const reported = (attributes: Record<string, string>) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.tapCause((cause) => Effect.flatMap(Telemetry, (telemetry) => telemetry.reportError(Cause.squash(cause), attributes))));

const discover = (source: (typeof SOURCES)[number]) =>
  discoverRss(source).pipe(Effect.catchCause((cause) =>
    Effect.gen(function* () {
      const err = Cause.squash(cause);
      const telemetry = yield* Telemetry;
      // Every feed of the creator has failed for hours (or the database failed), which a log alone would not alert on.
      yield* telemetry.reportError(err, { "video.source": source.id });
      yield* Effect.logError(`Discovery of ${source.id} failed`).pipe(Effect.annotateLogs({ "video.source": source.id, error: errorMessage(err) }));
    })));

export default {
  fetch(request: Request, env, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    const url = new URL(request.url);
    const [path, handler] = route(request, env, url, (p) => ctx.waitUntil(p));

    const effect = handler.pipe(
      Effect.tap((res) => annotate({ "http.response.status_code": res.status })),
      reported({ "http.route": path }),
      span(`${request.method} ${path}`, "http.server", {
        "http.request.method": request.method,
        "http.route": path,
        "url.path": url.pathname,
        "url.query": url.search.slice(1) || undefined,
      }, "server"),
    );

    return runApp(env, effect, (p) => ctx.waitUntil(p));
  },

  scheduled(controller, env, ctx): Promise<void> {
    const at = new Date(controller.scheduledTime);

    const effect = Effect.gen(function* () {
      if (controller.cron === "*/10 * * * *" && at.getUTCHours() === 0 && at.getUTCMinutes() < 10) {
        const deleted = yield* expireFrames(controller.scheduledTime).pipe(span("expire debug frames", "function"));
        yield* annotate({ "frames.expired": deleted });
      }

      yield* Effect.forEach(SOURCES, discover, { concurrency: "unbounded", discard: true });
      yield* startPending;
    }).pipe(reported({ "faas.cron": controller.cron }), span(`cron ${controller.cron}`, "faas.cron", { "faas.cron": controller.cron, "faas.trigger": "timer" }));

    return runApp(env, effect, (p) => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Env>;
