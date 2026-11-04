// Asks a vision LLM to transcribe the X posts on given frames.  bun ocr.ts <model> <framesDir> <seconds,csv>
import { readFileSync } from "node:fs";

const [model, dir, secondsCsv] = process.argv.slice(2);
const PROMPT =
  "This is a frame from a screen recording. Transcribe every X (Twitter) post visible on screen, including replies and quoted posts. " +
  "Output one line per post: @handle | display name | post text. Copy characters exactly; write ? for anything unreadable. Output nothing else.";

const seconds = secondsCsv.split(",");
for (let i = 0; i < seconds.length; i += 12) await Promise.all(
  seconds.slice(i, i + 12).map(async (s) => {
    const image = readFileSync(`${dir}/${String(Number(s) + 1).padStart(5, "0")}.jpg`).toString("base64");
    const started = Date.now();
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/a6221d3398c2e695ab8e1a2f1237bd1b/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CF_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 1500,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }],
      }),
    });
    const json: any = await res.json();
    const r = json.result ?? {};
    const text = r.response ?? r.choices?.[0]?.message?.content ?? JSON.stringify(json.errors);
    console.log(`== ${s}s (${Date.now() - started} ms, in=${r.usage?.prompt_tokens} out=${r.usage?.completion_tokens})\n${String(text).trim()}`);
  }),
);
