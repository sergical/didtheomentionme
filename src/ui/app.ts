/** The pages as one Foldkit app: the model, what each message changes, and the commands that talk to the browser. */
import { Effect, Schema } from "effect";
import * as Command from "foldkit/command";
import * as Dom from "foldkit/dom";
import type { Return } from "foldkit/update";
import { Flags, Message, Model, tabFor, type PageFlags } from "./model";
import { view } from "./views";

const TabSchema = Schema.Literals(["handle", "post", "text"]);
const ButtonSchema = Schema.Literals(["share", "copy"]);
const COPIED_MS = 1500;

// A page without a secure context has no `navigator.clipboard`, so its absence counts as a failed copy too.
const copied = (url: string) =>
  Effect.promise(async () => {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  });

const copyMessage = (url: string, button: "share" | "copy") =>
  copied(url).pipe(Effect.map((ok) => (ok ? Message.CopiedLink({ button }) : Message.FailedCopy({ url }))));

export const CopyLink = Command.define("CopyLink", {
  args: { url: Schema.String, button: ButtonSchema },
  messages: [Message.CopiedLink, Message.FailedCopy],
  execute: ({ url, button }) => copyMessage(url, button),
});

/** Opens the share sheet. Without one, or when it fails, copies the link instead. Closing the sheet is not a failure. */
export const ShareLink = Command.define("ShareLink", {
  args: { url: Schema.String, title: Schema.String },
  messages: [Message.Shared, Message.CopiedLink, Message.FailedCopy],
  execute: ({ url, title }) =>
    Effect.gen(function* () {
      if (!navigator.share) return yield* copyMessage(url, "share");
      const outcome = yield* Effect.promise(() =>
        navigator.share({ title, text: title, url }).then(() => "shared", (err: unknown) => ((err as Error)?.name === "AbortError" ? "closed" : "failed")));
      return outcome === "failed" ? yield* copyMessage(url, "share") : Message.Shared();
    }),
});

export const ResetCopyLater = Command.define("ResetCopyLater", {
  args: { button: ButtonSchema, copy: Schema.Number },
  messages: [Message.ResetCopy],
  execute: ({ button, copy }) => Effect.sleep(COPIED_MS).pipe(Effect.as(Message.ResetCopy({ button, copy }))),
});

const nextFrame = Effect.callback<void>((resume) => { requestAnimationFrame(() => resume(Effect.void)); });

/**
 * Focuses the input of a tab after the tab shows. A label click focuses only with a fine pointer: on a phone it
 * would open the keyboard over the page.
 */
export const FocusEntry = Command.define("FocusEntry", {
  args: { tab: TabSchema, fromLabel: Schema.Boolean },
  messages: [Message.Focused],
  execute: ({ tab, fromLabel }) =>
    Effect.gen(function* () {
      if (fromLabel && !matchMedia("(pointer: fine)").matches) return Message.Focused();
      yield* nextFrame;
      yield* Effect.ignore(Dom.focus(`#${tab}`, { preventScroll: fromLabel }));
      return Message.Focused();
    }),
});

export const init = (page: PageFlags): Return<Model, Message> => ({
  model: {
    page,
    tab: page.kind === "lookup" ? tabFor(page.input) : "handle",
    busy: false,
    copied: { share: 0, copy: 0 },
    copies: 0,
    status: "",
    statusVisible: false,
    hideCopy: false,
  },
});

export function update(model: Model, message: Message): Return<Model, Message> {
  switch (message._tag) {
    case "ChangedTab":
      return { model: { ...model, tab: message.tab } };
    case "ClickedTabLabel":
      return { model: { ...model, tab: message.tab }, commands: [FocusEntry({ tab: message.tab, fromLabel: true })] };
    case "ClickedSwitchTab":
      return { model: { ...model, tab: message.tab }, commands: [FocusEntry({ tab: message.tab, fromLabel: false })] };
    case "ClickedShare":
      return { model, commands: [ShareLink({ url: message.url, title: message.title })] };
    case "ClickedCopy":
      return { model, commands: [CopyLink({ url: message.url, button: "copy" })] };
    case "CopiedLink": {
      const copies = model.copies + 1;
      return {
        model: { ...model, copied: { ...model.copied, [message.button]: copies }, copies, status: "Result link copied." },
        commands: [ResetCopyLater({ button: message.button, copy: copies })],
      };
    }
    case "FailedCopy":
      return { model: { ...model, statusVisible: true, status: `Copy this link: ${message.url}` } };
    case "ResetCopy":
      if (model.copied[message.button] !== message.copy) return { model };
      return { model: { ...model, copied: { ...model.copied, [message.button]: 0 }, status: message.copy === model.copies ? "" : model.status } };
    case "SubmittedSearch":
      return { model: { ...model, busy: true } };
    case "ShowedPage":
      return { model: { ...model, busy: false } };
    case "DetectedSharing":
      return { model: { ...model, hideCopy: message.hideCopy } };
    case "Shared":
    case "Focused":
      return { model };
  }
}

/** What the server renders and the browser hydrates. */
export const app = { Flags, Model, init, update, view };
