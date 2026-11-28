/** Whether a request carries the admin token. A deploy without the secret authorizes nothing. */
export async function authorized(request: Request, env: { INTERNAL_TOKEN?: string }): Promise<boolean> {
  if (!env.INTERNAL_TOKEN) return false;
  const expected = new TextEncoder().encode(`Bearer ${env.INTERNAL_TOKEN}`);
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");

  return expected.length === given.length && crypto.subtle.timingSafeEqual(expected, given);
}
