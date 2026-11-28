/** Text helpers shared by the server and the browser. They must not import anything that only runs in a Worker. */

export const formatDate = (iso: string | null, withYear = true) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { year: withYear ? "numeric" : undefined, month: "short", day: "numeric", timeZone: "UTC" })
    : "";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A stable hue for a handle or a creator id, for avatars. */
export function hue(handle: string): number {
  let h = 0;

  for (const c of handle.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;

  return h;
}
