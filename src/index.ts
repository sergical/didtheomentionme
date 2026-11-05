import { logger, withSentry } from "@sentry/cloudflare";
import { DEFAULT_SOURCE, SOURCES, getSource } from "./config";
import { authorized } from "./auth";
import type { Env } from "./env";
import { LookupError, coverage, lookup } from "./lookup";
import { renderPage } from "./page";
import { exploreData, renderExplore } from "./explore";
import { socialImage } from "./social";
import { expireFrames } from "./retention";
import { sentryOptions, step } from "./telemetry";
import { backfill, destroyContainer, discoverRss, processNow, startPending } from "./videos";

export { ContainerProxy } from "@cloudflare/containers";
export { MediaContainer } from "./container";
export { VideoWorkflow } from "./workflow";

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function frame(env: Env, videoId: string, second: string, size: "f640" | "f1280" = "f1280"): Promise<Response> {
  const object = await env.BUCKET.get(`videos/${videoId}/${size}/${second}.jpg`);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=604800",
      etag: object.httpEtag,
    },
  });
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const source = getSource(url.searchParams.get("source"));
  if (!source) return Response.json({ error: "unknown source" }, { status: 400 });

  if (url.pathname === "/admin/backfill") {
    const days = Number(url.searchParams.get("days") ?? 30);
    if (!Number.isFinite(days) || days <= 0) return Response.json({ error: "bad days" }, { status: 400 });
    return Response.json(await backfill(env, source, days));
  }

  const videoId = url.searchParams.get("v") ?? "";
  if (!VIDEO_ID.test(videoId)) return Response.json({ error: "bad v" }, { status: 400 });
  if (url.pathname === "/admin/reset") {
    await destroyContainer(env, videoId);
    return Response.json({ videoId, result: "destroyed" });
  }
  return Response.json({ videoId, result: await processNow(env, videoId, source.id) });
}

async function lookupRoutes(env: Env, url: URL): Promise<Response> {
  const input = {
    handle: url.searchParams.get("handle") ?? "",
    tweet: url.searchParams.get("tweet") ?? "",
    q: url.searchParams.get("q") ?? "",
    source: url.searchParams.get("source"),
  };
  const asJson = url.pathname === "/api/lookup";
  const empty = !input.handle.trim() && !input.tweet.trim() && !input.q.trim();
  if (empty && asJson) {
    return Response.json({ error: "handle, tweet or q is required" }, { status: 400 });
  }

  try {
    if (asJson) return Response.json(await lookup(env, input));
  } catch (err) {
    if (!(err instanceof LookupError)) throw err;
    return Response.json({ error: err.message }, { status: 400 });
  }

  const { source, sources } = await pageSources(env, input.source);
  const page = { source, sources, input: { ...input, source: source.id } };
  if (empty) {
    return html(renderPage(page));
  }
  try {
    return html(renderPage({ ...page, result: await lookup(env, page.input) }));
  } catch (err) {
    if (!(err instanceof LookupError)) throw err;
    return html(renderPage({ ...page, error: err.message }), 400);
  }
}

// Pages fall back to the default creator for an unknown `source`.
async function pageSources(env: Env, requested: string | null) {
  const { id } = getSource(requested) ?? getSource(DEFAULT_SOURCE)!;
  const sources = await Promise.all(SOURCES.map(async (s) => ({ id: s.id, name: s.name, avatar: s.avatar, hue: s.hue, coverage: await coverage(env, s.id) })));
  return { source: sources.find((s) => s.id === id)!, sources };
}

async function exploreRoute(env: Env, url: URL): Promise<Response> {
  const { source, sources } = await pageSources(env, url.searchParams.get("source"));
  const sort = url.searchParams.get("sort") === "posts" ? "posts" : "newest";
  return html(renderExplore(await exploreData(env, source, sources, sort)));
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export default withSentry(sentryOptions, {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/admin/")) {
      if (!(await authorized(request, env))) return new Response("unauthorized", { status: 401 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (["/admin/backfill", "/admin/process", "/admin/reset"].includes(pathname)) return admin(request, env, url);
      return new Response("not found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });

    if (["/og.png", "/favicon.svg", "/apple-touch-icon.png"].includes(pathname)) return socialImage(env, url, ctx);

    const frameMatch = pathname.match(/^\/frame\/([A-Za-z0-9_-]+)\/(\d+)\.jpg$/);
    if (frameMatch) return frame(env, frameMatch[1], frameMatch[2], url.searchParams.get("size") === "640" ? "f640" : "f1280");
    if (pathname === "/" || pathname === "/api/lookup") return lookupRoutes(env, url);
    if (pathname === "/explore") return exploreRoute(env, url);
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (controller.cron === "*/10 * * * *" && new Date(controller.scheduledTime).getUTCHours() === 0 && new Date(controller.scheduledTime).getUTCMinutes() < 10) {
          await step("expire debug frames", () => expireFrames(env.BUCKET, env.DB, controller.scheduledTime));
        }
        const discovered = await Promise.allSettled(SOURCES.map((s) => step(`discover ${s.id}`, () => discoverRss(env, s))));
        discovered.forEach((r, i) => {
          if (r.status === "rejected") logger.error(logger.fmt`Discovery of ${SOURCES[i].id} failed`, { "video.source": SOURCES[i].id, error: String(r.reason?.message ?? r.reason) });
        });
        await step("start pending videos", () => startPending(env));
      })(),
    );
  },
} satisfies ExportedHandler<Env>);
