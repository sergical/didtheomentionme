import { Container, type StopParams } from "@cloudflare/containers";
import { authorized } from "./auth";
import type { Env } from "./env";

/**
 * The container uploads to this host and the Durable Object intercepts the requests.
 * Requests from the container to the Worker's own workers.dev URL never arrived.
 */
export const UPLOAD_HOST = "r2.internal";
const UPLOAD_PREFIX = "/internal/r2/";
const EVENTS_PREFIX = "/internal/events/";
/** The container sends this event to the workflow instance when its job is done or failed. */
export const EXTRACT_EVENT = "extract-done";
/**
 * The /jobs contract version, equal to `JOB_PROTOCOL` in container/server.py. A rollout replaces containers over
 * minutes, so a job can start on the image before it.
 */
export const JOB_PROTOCOL = 2;
const WATCHER_KEY = "job-watcher";

async function putObject(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405 });
  if (!(await authorized(request, env))) return new Response("unauthorized", { status: 401 });
  const { pathname } = new URL(request.url);
  const key = decodeURIComponent(pathname.slice(UPLOAD_PREFIX.length));
  if (!pathname.startsWith(UPLOAD_PREFIX) || !key.startsWith("videos/") || key.split("/").some((part) => part === ".." || part === "")) {
    return new Response("forbidden key", { status: 403 });
  }
  await env.BUCKET.put(key, await request.arrayBuffer(), {
    httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" },
  });
  return new Response(null, { status: 204 });
}

async function sendJobEvent(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!(await authorized(request, env))) return new Response("unauthorized", { status: 401 });
  const instanceId = decodeURIComponent(new URL(request.url).pathname.slice(EVENTS_PREFIX.length));
  const instance = await env.VIDEO_WORKFLOW.get(instanceId);
  await instance.sendEvent({ type: EXTRACT_EVENT, payload: await request.json() });
  return new Response(null, { status: 204 });
}

const route = (request: Request, env: Env) =>
  new URL(request.url).pathname.startsWith(EVENTS_PREFIX) ? sendJobEvent(request, env) : putObject(request, env);

export class MediaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  static {
    // Assign instead of declaring a static field: the base class's setter must run, because
    // ContainerProxy looks handlers up in the registry that the setter fills.
    this.outboundByHost = {
      [UPLOAD_HOST]: (request: Request, env: unknown) => route(request, env as Env),
    };
  }

  /** Saves the workflow instance that waits for this container's job. Only `destroy()` clears it. */
  async watchJob(instanceId: string): Promise<void> {
    await this.ctx.storage.put(WATCHER_KEY, instanceId);
  }

  override async destroy(): Promise<void> {
    await this.ctx.storage.delete(WATCHER_KEY);
    await super.destroy();
  }

  /** A crash, or an idle stop after a lost event, ends the wait at once instead of at its timeout. */
  override async onStop({ exitCode, reason }: StopParams): Promise<void> {
    const instanceId = await this.ctx.storage.get<string>(WATCHER_KEY);
    if (!instanceId) return;
    const payload = { state: "stopped", stage: null, error: `container stopped: ${reason}, exit ${exitCode}`, manifest: null };
    try {
      await (await this.env.VIDEO_WORKFLOW.get(instanceId)).sendEvent({ type: EXTRACT_EVENT, payload });
    } catch (err) {
      console.warn(`stopped event for ${instanceId} failed: ${err}`);
    }
  }

  // Only requests to the container count as activity, and nothing calls it while a job runs.
  override async onActivityExpired(): Promise<void> {
    const res = await this.containerFetch("http://container/busy").catch(() => null);
    if (res?.ok && (await res.json<{ busy: boolean }>()).busy) return this.renewActivityTimeout();
    await super.onActivityExpired();
  }
}
