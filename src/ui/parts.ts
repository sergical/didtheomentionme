/** Pieces both pages use. Like the views, they must stay pure: no `document`, `window` or `navigator`. */
import type { Attribute, HtmlBuilder } from "foldkit/html";
import type { Reading } from "../lookup";
import { formatTime } from "../pipeline";
import type { Message, SourceRef } from "./model";
import { formatDate, hue, plural } from "./text";

export type H = HtmlBuilder<Message>;

export type Node = ReturnType<H["div"]>;

export type Child = Node | string;

export const youtube = (videoId: string, seconds: number) =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(seconds)}s`;

type Icon = (h: H) => Node;

const svg = (h: H, viewBox: string, d: string, paint: Attribute<Message>[]) =>
  h.svg([h.ViewBox(viewBox), h.AriaHidden(true)], [h.path([h.Attribute("d", d), ...paint], [])]);

const stroke = (h: H, width: string): Attribute<Message>[] => [h.Fill("none"), h.Attribute("stroke", "currentColor"), h.Attribute("stroke-width", width),
  h.Attribute("stroke-linecap", "round"), h.Attribute("stroke-linejoin", "round")];

export const PLAY: Icon = (h) => svg(h, "0 0 10 12", "M0 0v12l10-6z", [h.Fill("currentColor")]);
const CHEVRON: Icon = (h) => svg(h, "0 0 12 12", "M2.5 4.5 6 8l3.5-3.5", stroke(h, "1.75"));
const CHECK: Icon = (h) => svg(h, "0 0 16 16", "m3.5 8.5 3 3 6-7", stroke(h, "2"));

/** Shorthands for attributes the builder names differently from HTML. */
export const at = (h: H) => ({
  newTab: [h.Attribute("target", "_blank"), h.Attribute("rel", "noopener noreferrer"), h.Attribute("aria-describedby", "new-tab-hint")],
  attr: (name: string, value: string | number) => h.Attribute(name, String(value)),
});

export const icon = (h: H, make: Icon) => make(h);

const face = (h: H, { id, avatar }: SourceRef) =>
  h.img([h.Class("face"), h.Src(avatar), h.Alt(""), h.Width("96"), h.Height("96"), h.Attribute("referrerpolicy", "no-referrer"), h.Attribute("style", `--hue:${hue(id)}`)]);

export function creatorPicker(h: H, source: SourceRef, sources: SourceRef[], href: (id: string) => string): Child {
  if (sources.length < 2) return source.name;
  const { attr } = at(h);
  const names = sources.map((s) => h.span(s.id === source.id ? [] : [h.AriaHidden(true)], [s.name]));

  const items = sources.map((s) => {
    const c = s.coverage;
    const meta = c.videos ? `${plural(c.videos, "video")} · ${formatDate(c.from, false)} to ${formatDate(c.to, false)}` : "First videos in progress";
    const current = s.id === source.id;

    return h.a([h.Href(href(s.id)), ...(current ? [attr("aria-current", "page")] : [])], [face(h, s), s.name, h.small([], [meta]), ...(current ? [icon(h, CHECK)] : [])]);
  });

  return h.details([h.Class("pick")], [
    h.summary([], [face(h, source), h.span([h.Class("names")], names), icon(h, CHEVRON)]),
    h.nav([h.Class("menu"), h.AriaLabel("Creators")], items),
  ]);
}

const READING_CAPTION: Record<Reading, string> = { all: "read it aloud", part: "read part of it aloud", comment: "talked about it" };

export const saidFigure = (h: H, sourceName: string, videoId: string, { at: time, quote, reading }: { at: number; quote: string; reading: Reading }) =>
  h.figure([h.Class(`said${reading === "comment" ? " comment" : ""}`)], [
    h.blockquote([], [quote]),
    h.figcaption([], [`${sourceName} ${READING_CAPTION[reading]} at `, h.a([...at(h).newTab, h.Href(youtube(videoId, time))], [formatTime(time)])]),
  ]);
