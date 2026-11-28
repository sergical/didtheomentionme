import { Effect, Option, Schema } from "effect";
import { httpFetch } from "./runtime";

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

/** The fields this app reads from the syndication endpoint's answer. A deleted or private post has no text or user. */
const decodePost = Schema.decodeUnknownOption(Schema.Struct({
  text: Schema.String,
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.Struct({ screen_name: Schema.String }),
}));

/** Returns null when the post cannot be fetched (deleted, private, blocked, timeout). */
export const fetchTweet = (id: string): Effect.Effect<TweetInfo | null> =>
  httpFetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}`, {
    // The endpoint answers 400 to a request with no user agent, and Workers sends none.
    headers: { "user-agent": "didtheomentionme/1.0 (+https://didtheomention.me)" },
    signal: AbortSignal.timeout(5000),
  }).pipe(
    Effect.flatMap((res) => (res.ok ? Effect.promise(() => res.json()) : Effect.succeed(null))),
    Effect.map((body) => Option.getOrNull(decodePost(body))),
    Effect.map((post) => (post?.text && post.user.screen_name ? { id, handle: post.user.screen_name, text: post.text, createdAt: post.created_at ?? null } : null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
