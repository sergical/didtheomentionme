// The Workers AI REST API as the experiments call it: one request with retries, and the answer shapes of the models.
import { Option, Schema } from "effect";
import type { ModelInputs } from "../../src/env";

const ACCOUNT = Bun.env.CF_ACCOUNT_ID ?? "";
const TOKEN = Bun.env.CF_TOKEN ?? "";

const Probability = Schema.optional(Schema.Number);
const Tokens = Schema.optional(Schema.Number);
const Span = Schema.Tuple([Schema.Number, Schema.Number]);

/** One answered question or field. Clef answers `noul`. Clairic answers a value, and where in the text it found it. */
const Field = Schema.Struct({
  noul: Probability,
  value: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)]))),
  guess: Schema.optional(Schema.NullOr(Schema.String)),
  p_null: Probability,
  confidence: Probability,
  span: Schema.optional(Schema.NullOr(Span)),
  spans: Schema.optional(Schema.Array(Span)),
});

/** What the experiments read from a model's answer. `error` is set when the request failed. */
const Answer = Schema.Struct({
  answers: Schema.optional(Schema.Record(Schema.String, Field)),
  usage: Schema.optional(Schema.Struct({ input_tokens: Tokens, prompt_tokens: Tokens, completion_tokens: Tokens })),
  choices: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) })) }))),
  response: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.String),
});

export type Answer = typeof Answer.Type;

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ result: Schema.optional(Schema.NullOr(Answer)), errors: Schema.optional(Schema.Unknown) })));

/** The API's reply to one request: the model's answer when it has one, the API's own errors, and the reply as text. */
export async function ask(model: string, body: ModelInputs) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => new Response(null, { status: 599 }));

  const text = await res.text();
  const reply = Option.getOrUndefined(decodeReply(text));

  return { status: res.status, answer: res.ok ? (reply?.result ?? undefined) : undefined, errors: reply?.errors, text };
}

/** A model's answer. A rate limit or a server error is tried again up to 4 times; any other failure is the answer's `error`. */
export async function run(model: string, body: ModelInputs): Promise<Answer> {
  for (let attempt = 0; ; attempt++) {
    const { status, answer, text } = await ask(model, body);

    if (answer) return answer;

    if (attempt >= 4 || (status !== 429 && status < 500)) return { error: `${status} ${text.slice(0, 300)}` };
    await Bun.sleep(1000 * 2 ** attempt);
  }
}

/** The text of a chat model's answer. */
export const chatText = (answer: Answer) => answer.choices?.[0]?.message?.content ?? undefined;

export const isText = Schema.is(Schema.String);
export const isTexts = Schema.is(Schema.Array(Schema.String));

/** Runs `fn` over the items, `size` at a time. */
export async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await fn(items[next++]); }));
}
