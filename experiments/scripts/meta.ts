// Post metadata: gemma-4 copies each post's date and counts as shown, clairic turns them into typed values.
//   bun meta.ts <framesDir> <secondsCsv> <out.jsonl>
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const ACCOUNT = "a6221d3398c2e695ab8e1a2f1237bd1b";
const TOKEN = process.env.CF_TOKEN ?? "";
const VIDEO_DATE = "2026-10-08";
const READ_PROMPT =
  "Transcribe every X (Twitter) post visible on screen, including replies and quoted posts. Output one line per post: " +
  "@handle | time or date exactly as shown next to the post (e.g. 7h, Sep 24, 1:05 AM · Sep 24, 2026) | replies | reposts | likes | views | first 60 characters of the post text. " +
  "Leave a column empty if it is not shown. Copy characters exactly. Output nothing else.";

async function run(model: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => new Response(null, { status: 599 }));
    if (res.ok) return (await res.json()).result;
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
    await Bun.sleep(1000 * 2 ** attempt);
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await fn(items[next++]); }));
}

const [dir, secondsCsv, out] = process.argv.slice(2);
writeFileSync(out, "");
const lines: { t: number; line: string }[] = [];

await pool(secondsCsv.split(",").map(Number), 12, async (t) => {
  const file = join(dir, `${String(t + 1).padStart(5, "0")}.jpg`);
  const r = await run("@cf/google/gemma-4-26b-a4b-it", {
    messages: [{ role: "user", content: [
      { type: "text", text: READ_PROMPT },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${readFileSync(file).toString("base64")}` } },
    ] }],
    max_tokens: 1200,
    chat_template_kwargs: { enable_thinking: false },
  });
  for (const line of (r.choices?.[0]?.message?.content ?? "").split("\n")) {
    if (line.trim().startsWith("@") && line.split("|").length >= 6) lines.push({ t, line: line.trim() });
  }
});

// One clairic call per distinct post line that shows any metadata.
const seen = new Set<string>();
const posts = lines.filter(({ line }) => {
  const cols = line.split("|").map((c) => c.trim());
  const key = `${cols[0]}|${cols.slice(1, 6).join("|")}|${cols[6]?.slice(0, 20)}`;
  if (seen.has(key) || cols.slice(1, 6).every((c) => !c)) return false;
  seen.add(key);
  return true;
});

await pool(posts, 8, async ({ t, line }) => {
  const r = await run("@cf/cloudflare/clairic", {
    model: "clairic",
    reference_date: VIDEO_DATE,
    state: `An X post as shown in a video recorded on ${VIDEO_DATE}. Columns: handle | time shown | replies | reposts | likes | views | text\n${line}`,
    fields: {
      posted: { type: "date", instructions: "The date the post was published. A relative age like 7h or 2d counts back from the recording date." },
      replies: { type: "number", integer: true, instructions: "Reply count. 1.2K means 1200." },
      reposts: { type: "number", integer: true, instructions: "Repost count. 1.2K means 1200." },
      likes: { type: "number", integer: true, instructions: "Like count. 1.2K means 1200." },
      views: { type: "number", integer: true, instructions: "View count. 1.2M means 1200000." },
    },
  });
  const a = r.answers ?? {};
  const pick = (k: string) => ({ v: a[k]?.value ?? null, p_null: a[k]?.p_null && +a[k].p_null.toFixed(2), conf: a[k]?.confidence && +a[k].confidence.toFixed(2) });
  appendFileSync(out, JSON.stringify({ t, line, posted: pick("posted"), replies: pick("replies"), reposts: pick("reposts"), likes: pick("likes"), views: pick("views"), tokens: r.usage?.input_tokens, error: r.error }) + "\n");
});
console.log(`frames read, ${lines.length} post lines, ${posts.length} sent to clairic`);
