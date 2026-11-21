import { expect, test } from "bun:test";
import { init, update } from "../src/ui/app";
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

test("only the reset of the last copy clears the copied label", () => {
  const twice = run(start(), Message.CopiedLink({ button: "copy" }), Message.CopiedLink({ button: "share" }));
  expect(twice).toMatchObject({ copied: "share", status: "Result link copied." });
  expect(run(twice, Message.ResetCopy({ copy: 1 }))).toMatchObject({ copied: "share", status: "Result link copied." });
  expect(run(twice, Message.ResetCopy({ copy: 2 }))).toMatchObject({ copied: null, status: "" });
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
