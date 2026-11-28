/** Server side of the pages: the document head, and the body that Foldkit renders for the browser to hydrate. */
import { Effect } from "effect";
import * as Server from "foldkit/experimental/server";
import { explorePath, resultPath, shareTitle, SITE_ORIGIN } from "../share";
import { app } from "./app";
import { CLIENT_BUILD, clientPath } from "./build";
import type { ExploreData, PageData, PageFlags } from "./model";
import { EXPLORE_STYLE, STYLE } from "./style";
import { plural } from "./text";

const escapes = new Map([["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"]]);
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => escapes.get(c) ?? c);

export interface HeadData {
  title: string;
  /** The social preview text. */
  description: string;
  /** The search result text. */
  metaDescription: string;
  canonical: string;
  image: string;
  hue: number;
  style?: string;
}

export function documentHead({ title, description, metaDescription, canonical, image, hue, style = "" }: HeadData): string {
  return `<!doctype html>
<html lang="en" style="--accent-h:${hue};--tint-h:${hue - 50}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0e0c12" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fbf9fb" media="(prefers-color-scheme: light)">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="modulepreload" href="${clientPath(CLIENT_BUILD)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)} Video moments, with receipts.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="description" content="${esc(metaDescription)}">
<style>${STYLE}${style}</style>
</head>
`;
}

/** The page body: Foldkit's HTML, the page data as JSON for hydration, and the browser script. */
const body = (flags: PageFlags) =>
  Server.renderToString(app, { flags, buildId: CLIENT_BUILD }).pipe(
    Effect.map(({ html }) => `<body>\n${html}\n<script type="module" src="${clientPath(CLIENT_BUILD)}"></script>\n</body>\n</html>`),
    // A render error is our bug, not the visitor's: it goes to the request span as a defect.
    Effect.orDie,
  );

export const renderPage = (data: PageData) =>
  Effect.gen(function* () {
    const title = shareTitle(data.source.name, data.result);
    const path = resultPath(data.input, data.source.id);

    const head = documentHead({
      title,
      description: `Find the exact moments ${data.source.name} showed X posts on screen, with video frames and links to each second.`,
      metaDescription: `Find out if ${data.source.name} showed or read your X post in a video.`,
      canonical: SITE_ORIGIN + path,
      image: SITE_ORIGIN + "/og.png" + path.slice(1),
      hue: data.source.hue,
    });

    return head + (yield* body({ kind: "lookup", ...data }));
  });

export const renderExplore = (data: ExploreData) =>
  Effect.gen(function* () {
    const { source, totals } = data;
    const description = `Every X post ${source.name} showed on screen in ${plural(totals.videos, "video")}, with the most shown accounts.`;

    const head = documentHead({
      title: `What did ${source.name} show?`,
      description,
      metaDescription: description,
      canonical: SITE_ORIGIN + explorePath(source.id, data.sort),
      image: `${SITE_ORIGIN}/og.png?source=${encodeURIComponent(source.id)}`,
      hue: source.hue,
      style: EXPLORE_STYLE,
    });

    return head + (yield* body({ kind: "explore", ...data }));
  });
