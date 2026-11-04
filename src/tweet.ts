export interface TweetInfo {
  id: string;
  handle: string;
  text: string;
  createdAt: string | null;
}

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/?#]+\/status(?:es)?\/(\d+)/i;

export function parseTweetId(url: string): string | null {
  return url.trim().match(STATUS_URL)?.[1] ?? null;
}

export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** Returns null when the post cannot be fetched (deleted, private, blocked, timeout). */
export async function fetchTweet(id: string): Promise<TweetInfo | null> {
  try {
    const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}`, {
      // The endpoint answers 400 to a request with no user agent, and Workers sends none.
      headers: { "user-agent": "didtheomentionme/1.0 (+https://didtheomention.me)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string; created_at?: string; user?: { screen_name?: string } };
    if (!data.text || !data.user?.screen_name) return null;
    return { id, handle: data.user.screen_name, text: data.text, createdAt: data.created_at ?? null };
  } catch {
    return null;
  }
}
