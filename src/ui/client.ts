/** The browser entry: takes over the page the server rendered, with the page data the server put in it. */
import * as Runtime from "foldkit/runtime";
import { app } from "./app";

// The script's own file name holds the build it belongs to: /app-<build>.js.
const build = /\/app-([\w-]+)\.js$/.exec(new URL(import.meta.url).pathname)?.[1] ?? "";

Runtime.hydrate(
  Runtime.makeApplication({ ...app, container: document.querySelector<HTMLElement>("[data-foldkit-app]") }),
  { buildId: build },
);
