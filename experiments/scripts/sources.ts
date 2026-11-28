// Transcript-only mention finding: which people or accounts does the speaker cite as the author of a post?
// Runs clairic and gemma-4 over overlapping caption chunks.
//   bun sources.ts <words.tsv> <out.jsonl>
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { chatText, isTexts, run, type Answer } from "./workers-ai";

const INSTRUCTIONS = "Names or handles of people or accounts whose post, tweet, reply or message the speaker reads, quotes or describes. Exclude the speaker himself.";

const words = readFileSync(Bun.argv[2], "utf8").trim().split("\n").map((l) => {
  const [t, w] = l.split("\t");

  return [Number(t), w] as const;
});

const out = Bun.argv[3];

writeFileSync(out, "");

const end = words.at(-1)![0];

const chunks: number[] = [];

for (let s = 0; s < end; s += 100) chunks.push(s);

/** The transcript of the 120 seconds from `start`, and the time of the word at a character of it. */
function chunk(start: number) {
  let state = "";
  const offsets: [number, number][] = [];

  for (const [t, w] of words.filter(([t]) => t >= start && t < start + 120)) {
    offsets.push([state.length, t]);
    state += (state ? " " : "") + w;
  }

  return { state, timeAt: (char: number) => Math.round(offsets.findLast(([o]) => o <= char)?.[1] ?? start) };
}

/** Each name Clairic found, with the time of its first word, or `?` when Clairic gave no place. */
function namesWithTimes(answer: Answer, timeAt: (char: number) => number) {
  const sources = answer.answers?.sources;
  const names = isTexts(sources?.value) ? sources.value : [];

  return names.map((name, i) => {
    const span = sources?.spans?.[i];

    return `${name}@${span ? timeAt(span[0]) : "?"}`;
  });
}

const lines = (text: string) => text.split("\n").flatMap((line) => (line.trim() && line.trim() !== "NONE" ? [line.trim()] : []));

await Promise.all(
  chunks.map(async (start) => {
    const { state, timeAt } = chunk(start);

    const [c, g] = await Promise.all([
      run("@cf/cloudflare/clairic", { model: "clairic", state, fields: { sources: { type: "list", items: "text", instructions: INSTRUCTIONS } } }),
      run("@cf/google/gemma-4-26b-a4b-it", {
        messages: [{ role: "user", content: `Transcript of a tech streamer:\n\n${state}\n\n${INSTRUCTIONS} Output one name per line, nothing else. Output NONE if there are none.` }],
        max_tokens: 200,
        chat_template_kwargs: { enable_thinking: false },
      }),
    ]);

    appendFileSync(
      out,
      JSON.stringify({
        start,
        clairic: namesWithTimes(c, timeAt),
        clairic_conf: c.answers?.sources?.confidence,
        gemma: lines(chatText(g) ?? g.error ?? ""),
        tokens: [c.usage?.input_tokens, g.usage?.prompt_tokens],
      }) + "\n",
    );
  }),
);

console.log("done");
