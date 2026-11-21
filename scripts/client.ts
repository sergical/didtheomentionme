/**
 * Builds the browser script for the pages into `dist/client`, which the Worker serves as static assets. The file
 * name holds a hash of its content, so a browser can keep it for good and a new deploy never serves a page an old
 * script. Alchemy runs this before each deploy and dev session; see alchemy.run.ts.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { rolldown } from "rolldown";

export const CLIENT_DIR = "dist/client";

export async function buildClient(): Promise<{ build: string; bytes: number }> {
  const bundle = await rolldown({
    input: "src/ui/client.ts",
    platform: "browser",
    transform: { define: { "process.env.NODE_ENV": '"production"' } },
  });
  const { output } = await bundle.generate({ format: "esm", minify: true, codeSplitting: false });
  await bundle.close();
  const [entry] = output;
  if (output.length !== 1 || entry.type !== "chunk") throw new Error(`expected one browser chunk, got ${output.length} files`);
  const build = createHash("sha256").update(entry.code).digest("hex").slice(0, 12);
  await rm(CLIENT_DIR, { recursive: true, force: true });
  await mkdir(CLIENT_DIR, { recursive: true });
  await writeFile(`${CLIENT_DIR}/app-${build}.js`, entry.code);
  await writeFile(`${CLIENT_DIR}/_headers`, "/app-*\n  Cache-Control: public, max-age=31536000, immutable\n");
  return { build, bytes: entry.code.length };
}

if (import.meta.main) console.log(await buildClient());
