// Transcript-only mention finding: which people or accounts does the speaker cite as the author of a post?
// Runs clairic and gemma-4 over overlapping caption chunks.
//   bun sources.ts <words.tsv> <out.jsonl>
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const ACCOUNT = process.env.CF_ACCOUNT_ID ?? "";
const TOKEN = process.env.CF_TOKEN ?? "";
const INSTRUCTIONS = "Names or handles of people or accounts whose post, tweet, reply or message the speaker reads, quotes or describes. Exclude the speaker himself.";

async function run(model: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()).result;
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
    await Bun.sleep(1000 * 2 ** attempt);
  }
}

const words = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => {
  const [t, w] = l.split("\t");
  return [Number(t), w] as const;
});
const out = process.argv[3];
writeFileSync(out, "");
const end = words.at(-1)![0];

const chunks: number[] = [];
for (let s = 0; s < end; s += 100) chunks.push(s);

await Promise.all(
  chunks.map(async (start) => {
    let state = "";
    const offsets: [number, number][] = [];
    for (const [t, w] of words.filter(([t]) => t >= start && t < start + 120)) {
      offsets.push([state.length, t]);
      state += (state ? " " : "") + w;
    }
    const timeAt = (char: number) => Math.round(offsets.findLast(([o]) => o <= char)?.[1] ?? start);
    const [c, g] = await Promise.all([
      run("@cf/cloudflare/clairic", { model: "clairic", state, fields: { sources: { type: "list", items: "text", instructions: INSTRUCTIONS } } }),
      run("@cf/google/gemma-4-26b-a4b-it", {
        messages: [{ role: "user", content: `Transcript of a tech streamer:\n\n${state}\n\n${INSTRUCTIONS} Output one name per line, nothing else. Output NONE if there are none.` }],
        max_tokens: 200,
        chat_template_kwargs: { enable_thinking: false },
      }),
    ]);
    const a = c.answers?.sources;
    appendFileSync(
      out,
      JSON.stringify({
        start,
        clairic: (a?.value ?? []).map((v: string, i: number) => `${v}@${a.spans?.[i] ? timeAt(a.spans[i][0]) : "?"}`),
        clairic_conf: a?.confidence,
        gemma: (g.choices?.[0]?.message?.content ?? g.error ?? "").split("\n").map((s: string) => s.trim()).filter((s: string) => s && s !== "NONE"),
        tokens: [c.usage?.input_tokens, g.usage?.prompt_tokens],
      }) + "\n",
    );
  }),
);
console.log("done");
