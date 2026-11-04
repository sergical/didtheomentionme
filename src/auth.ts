import type { Env } from "./env";

export async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.INTERNAL_TOKEN) return false;
  const expected = new TextEncoder().encode(`Bearer ${env.INTERNAL_TOKEN}`);
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  return expected.length === given.length && crypto.subtle.timingSafeEqual(expected, given);
}
