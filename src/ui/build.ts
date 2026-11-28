declare const __CLIENT_BUILD__: string | undefined;

/**
 * The content hash of the browser script, which the deploy builds into `dist/client/app-<hash>.js` and writes into
 * the Worker bundle. Foldkit stamps it on each page and the script checks it, so a page only hydrates with the script
 * of its own deploy. Tests and type checks run without a build and get "dev".
 */
export const CLIENT_BUILD = typeof __CLIENT_BUILD__ === "undefined" ? "dev" : __CLIENT_BUILD__;

export const clientPath = (build: string) => `/app-${build}.js`;
