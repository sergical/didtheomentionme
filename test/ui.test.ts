import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as Server from "foldkit/experimental/server";
import { CopyLink, app, init, update } from "../src/ui/app";
import { Message, type Model, type PageFlags } from "../src/ui/model";

const source = { id: "theo", name: "Theo", avatar: "/theo.png", hue: 350, coverage: { videos: 1, from: null, to: null } };
const page = (input: { handle: string; tweet: string; q?: string }): PageFlags => ({ kind: "lookup", source, sources: [source], input });
const start = (input = { handle: "", tweet: "" }) => init(page(input)).model;
const run = (model: Model, ...messages: Message[]) => messages.reduce((m, message) => update(m, message).model, model);

test("the page opens on the tab of the search it shows", () => {
  expect(start({ handle: "theo", tweet: "" }).tab).toBe("handle");
  expect(start({ handle: "", tweet: "https://x.com/a/status/1" }).tab).toBe("post");
  expect(start({ handle: "theo", tweet: "", q: "two words" }).tab).toBe("text");
});

test("a label click and the verdict's switch button focus the tab's input, a keyboard tab change does not", () => {
  const model = start();
  const names = (message: Message) => (update(model, message).commands ?? []).map((c) => [c.name, c.args]);
  expect(names(Message.ClickedTabLabel({ tab: "text" }))).toEqual([["FocusEntry", { tab: "text", fromLabel: true }]]);
  expect(names(Message.ClickedSwitchTab({ tab: "handle" }))).toEqual([["FocusEntry", { tab: "handle", fromLabel: false }]]);
  expect(names(Message.ChangedTab({ tab: "post" }))).toEqual([]);
  expect(update(model, Message.ChangedTab({ tab: "post" })).model.tab).toBe("post");
});

test("each button keeps its copied label for its own time", () => {
  const both = run(start(), Message.CopiedLink({ button: "copy" }), Message.CopiedLink({ button: "share" }));
  expect(both.copied).toEqual({ copy: 1, share: 2 });
  const copyReset = run(both, Message.ResetCopy({ button: "copy", copy: 1 }));
  expect(copyReset).toMatchObject({ copied: { copy: 0, share: 2 }, status: "Result link copied." });
  expect(run(copyReset, Message.ResetCopy({ button: "share", copy: 2 }))).toMatchObject({ copied: { copy: 0, share: 0 }, status: "" });
  // A second copy on the same button outlives the reset of the first.
  const again = run(start(), Message.CopiedLink({ button: "copy" }), Message.CopiedLink({ button: "copy" }), Message.ResetCopy({ button: "copy", copy: 1 }));
  expect(again.copied.copy).toBe(2);
});

test("a browser without the Clipboard API shows the link to copy by hand", async () => {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  try {
    expect(await Effect.runPromise(CopyLink({ url: "https://didtheomention.me/?handle=a", button: "copy" }).effect)).toEqual(Message.FailedCopy({ url: "https://didtheomention.me/?handle=a" }));
  } finally {
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
  }
});

test("a lookup error stays on the searched tab's field when another tab opens", async () => {
  const flags: PageFlags = { ...page({ handle: "bad handle", tweet: "" }), error: "Invalid handle" } as PageFlags;
  const onText = { ...app, init: (f: PageFlags) => ({ model: { ...init(f).model, tab: "text" as const } }) };
  const { html } = await Effect.runPromise(Server.renderToString(onText, { flags, buildId: "test" }));
  const tag = (id: string) => html.match(new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>([^<]*)`))!;
  expect(tag("handle-hint")[1]).toBe("Invalid handle");
  expect(tag("text-hint")[1]).toBe("A few words you remember. Matches by words and by meaning.");
  expect(tag("handle")[0]).toContain('aria-invalid="true"');
  expect(tag("text")[0]).not.toContain("aria-invalid");
});

test("a failed copy shows the link to copy by hand", () => {
  expect(run(start(), Message.FailedCopy({ url: "https://didtheomention.me/?handle=a" }))).toMatchObject({
    statusVisible: true,
    status: "Copy this link: https://didtheomention.me/?handle=a",
  });
});

test("a search is busy until the next page shows, also when the browser restores this one", () => {
  const busy = run(start(), Message.SubmittedSearch());
  expect(busy.busy).toBe(true);
  expect(run(busy, Message.ShowedPage()).busy).toBe(false);
});
