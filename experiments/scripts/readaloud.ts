// Did the speaker read a given on-screen post aloud, and where? Compares clairic, Clef and a lexical baseline
// on caption windows around each ground-truth interval.
//   bun readaloud.ts <cases.json> <out.jsonl>
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const ACCOUNT = process.env.CF_ACCOUNT_ID ?? "";
const TOKEN = process.env.CF_TOKEN ?? "";

// [case id, handle, post text prefix, read aloud?, approx second]
const LABELS: [number, string, string, boolean, number?][] = [
  [0, "@theo", "Anthropic has no small", true, 45],
  [0, "@ajambrosino", "lmao", false],
  [0, "@theo", "love u but not using astra", false],
  [1, "@claudeai", "Along with this launch", true, 274],
  [1, "@claudeai", "On average, it costs around 75%", true, 268],
  [2, "@lydiahallie", "If you're on API billing", true, 510],
  [3, "@ThePrimeagen", "tested out Haiku vs Luna reasoning", true, 622],
  [4, "@theo", "Okay this makes sense now", true, 648],
  [5, "@gautamgoel978", "all 3 statements are false", true, 1112],
  [5, "@theo", "Imao this guy uses haiku", true, 1115],
  [6, "@thisisdkyadav", "what use cases", false],
  [6, "@Eg0Chycken", "Use case for haiku", false],
  [6, "@zzaneyes", "even they could", false],
  [6, "@EdzonDev", "In 2026", false],
  [7, "@elonmusk", "Congrats", true, 1282],
  [7, "@thekitze", "rip luna", false],
  [8, "@ArtificialAnlys", "Claude Haiku 5.5 (max)", false],
  [10, "@ClaudeDevs", "Haiku 5.5 is now available", false],
  [12, "@be_arsh", "Claude Haiku 5.5 just one shot", false],
  [12, "@be_arsh", "sort of wild", true, 1500],
  [12, "@0xtoberry", "this is really good", false],
  [14, "@theo", "Anthropic has no small", true, 2414],
];

async function run(model: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()).result;
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
    await Bun.sleep(1000 * 2 ** attempt);
  }
}

const STOP = new Set("the a an and or of to in on for is are was it this that with be at by as so i you we they he she my your our their just not but have has had from".split(" "));
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9$.%]+/g)?.map((t) => t.replace(/\.$/, "")).filter((t) => t.length > 1 && !STOP.has(t)) ?? [];

function lexical(post: string, words: [number, string][]) {
  const want = new Set(tokens(post));
  const said = words.map(([t, w]) => [t, tokens(w)[0]] as const);
  const width = Math.max(8, want.size * 2);
  let best = { score: 0, t: 0 };
  for (let i = 0; i < said.length; i++) {
    const hit = new Set(said.slice(i, i + width).map(([, w]) => w).filter((w) => w && want.has(w)));
    const score = hit.size / Math.max(1, want.size);
    if (score > best.score) best = { score, t: said[i][0] };
  }
  return best;
}

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = process.argv[3];
writeFileSync(out, "");

await Promise.all(
  LABELS.map(async ([id, handle, prefix, read, at]) => {
    const c = cases.find((x: any) => x.id === id);
    const post = c.posts.find((p: any) => p.handle === handle && p.text.startsWith(prefix));
    const words: [number, string][] = c.words;
    let state = "";
    const offsets: [number, number][] = [];
    for (const [t, w] of words) {
      offsets.push([state.length, t]);
      state += (state ? " " : "") + w;
    }
    const timeAt = (char: number) => offsets.findLast(([o]) => o <= char)?.[1];
    const postRef = `this X post by ${handle}: "${post.text}"`;
    const question = `This is a transcript of a tech streamer while ${postRef} is on screen. Does the speaker read aloud, quote or paraphrase that post's content?`;
    const [clairic, flash, clef] = await Promise.all([
      run("clairic", {
        model: "clairic",
        state,
        fields: { quote: { type: "text", instructions: `The words where the speaker reads aloud, quotes or paraphrases ${postRef}. Null if the speaker does not.` } },
      }),
      run("clef-flash", { model: "clef-flash", state, questions: { read: { type: "noul", instructions: question } } }),
      run("clef", { model: "clef", state, questions: { read: { type: "noul", instructions: question } } }),
    ]);
    const q = clairic.answers?.quote ?? {};
    appendFileSync(
      out,
      JSON.stringify({
        id, handle, prefix, read, at,
        clairic: { value: q.value, guess: q.guess, p_null: q.p_null, conf: q.confidence, t: q.span ? timeAt(q.span[0]) : null, tokens: clairic.usage?.input_tokens, error: clairic.error },
        flash: { p: flash.answers?.read?.noul, tokens: flash.usage?.input_tokens, error: flash.error },
        clef: { p: clef.answers?.read?.noul, tokens: clef.usage?.input_tokens, error: clef.error },
        lexical: lexical(post.text, words),
      }) + "\n",
    );
  }),
);
console.log("done");
