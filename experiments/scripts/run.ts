// Runs the frame-detection experiment against the Workers AI REST API.
//   bun run.ts flash   <framesDir> <out.jsonl>
//   bun run.ts omni    <clipsDir>  <out.jsonl>
//   bun run.ts clairic <framesDir> <seconds,comma,separated> <out.jsonl>
// Frames are named NNNNN.jpg where NNNNN = second + 1 (ffmpeg fps=1 output).
import { readdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isText, pool, run } from "./workers-ai";

const STATE = "A frame from a YouTube video by a tech streamer: a screen recording of a web browser with a facecam overlay.";

const TWEET_QUESTION =
  "Is a post from X (Twitter) clearly visible and readable as main content of the screen (a post page, timeline, search results, embed or screenshot)? Small sidebar items and avatars do not count.";

const b64 = (path: string) => readFileSync(path).toString("base64");
const secondOf = (file: string) => Number.parseInt(file, 10) - 1;

const [mode, dir, ...rest] = Bun.argv.slice(2);
const out = rest.at(-1)!;

writeFileSync(out, "");

const started = Date.now();

if (mode === "flash") {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  await pool(files, 12, async (file) => {
    const r = await run("@cf/cloudflare/clef-flash", {
      model: "clef-flash",
      state: STATE,
      images: [{ content_type: "image/jpeg", base64: b64(join(dir, file)) }],
      questions: { tweet: { type: "noul", instructions: TWEET_QUESTION } },
    });

    appendFileSync(out, JSON.stringify({ t: secondOf(file), p: r.answers?.tweet?.noul, tokens: r.usage?.input_tokens, error: r.error }) + "\n");
  });
} else if (mode === "omni") {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort();
  await pool(files, 6, async (file) => {
    const r = await run("@cf/cloudflare/clef-omni", {
      model: "clef-omni",
      state: "A 60 second clip from a YouTube video by a tech streamer: a screen recording of a web browser with a facecam overlay.",
      videos: [{ content_type: "video/mp4", base64: b64(join(dir, file)) }],
      questions: { tweet: { type: "noul", instructions: `At any moment in this clip: ${TWEET_QUESTION}` } },
    });

    appendFileSync(out, JSON.stringify({ clip: Number.parseInt(file, 10), p: r.answers?.tweet?.noul, tokens: r.usage?.input_tokens, error: r.error }) + "\n");
  });
} else if (mode === "clairic") {
  const seconds = rest[0].split(",").map(Number);
  await pool(seconds, 6, async (t) => {
    const file = `${String(t + 1).padStart(5, "0")}.jpg`;

    const r = await run("@cf/cloudflare/clairic", {
      model: "clairic",
      images: [{ content_type: "image/jpeg", base64: b64(join(dir, file)) }],
      fields: {
        handles: { type: "list", items: "text", instructions: "The @handle of every author of an X (Twitter) post visible on screen." },
        main_handle: { type: "text", instructions: "The @handle of the author of the main, most prominent X post." },
        main_display_name: { type: "text", instructions: "The display name of the author of the main X post." },
        main_text: { type: "text", instructions: "The full text of the main X post." },
      },
    });

    const a = r.answers ?? {};
    const text = a.main_text?.value;
    appendFileSync(
      out,
      JSON.stringify({
        t,
        handles: a.handles?.value,
        main_handle: a.main_handle?.value,
        main_handle_conf: a.main_handle?.confidence,
        name: a.main_display_name?.value,
        text: isText(text) ? text.slice(0, 120) : undefined,
        tokens: r.usage?.input_tokens,
        error: r.error,
      }) + "\n",
    );
  });
}

console.log(`${mode} done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
