import { Container } from "@cloudflare/containers";
import { authorized } from "./auth";
import type { Env } from "./env";

/**
 * The container uploads to this host and the Durable Object intercepts the requests.
 * Requests from the container to the Worker's own workers.dev URL never arrived.
 */
export const UPLOAD_HOST = "r2.internal";
const UPLOAD_PREFIX = "/internal/r2/";

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

export class MediaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  static {
    // Assign instead of declaring a static field: the base class's setter must run, because
    // ContainerProxy looks handlers up in the registry that the setter fills.
    this.outboundByHost = {
      [UPLOAD_HOST]: (request: Request, env: unknown) => putObject(request, env as Env),
    };
  }
}
