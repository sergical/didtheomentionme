import type { LookupInput, LookupResult } from "./lookup";

export const SITE_ORIGIN = "https://didtheomention.me";

export function resultPath(input: LookupInput, source: string): string {
  const params = new URLSearchParams();
  for (const key of ["handle", "tweet", "q"] as const) {
    const value = input[key]?.trim();
    if (value) params.set(key, value);
  }
  params.set("source", source);
  return `/?${params}`;
}

export const explorePath = (source: string, sort: "newest" | "posts" = "newest") =>
  `/explore?${new URLSearchParams(sort === "posts" ? { source, sort } : { source })}`;

export function shareTitle(name: string, result?: LookupResult): string {
  if (!result) return `Did ${name} mention me?`;
  const matches = result.matches.filter((m) => !result.query || (m.overlap ?? 0) >= 0.75);
  const count = matches.reduce((sum, m) => sum + m.times.length, 0);
  const subject = result.query ? "that text" : `@${result.handle}`;
  return count ? `${name} showed ${subject} ${count} time${count === 1 ? "" : "s"}.` : `Did ${name} show ${subject}?`;
}
