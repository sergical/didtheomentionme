import { Effect, Queue, Stream } from "effect";
import * as Mount from "foldkit/mount";
import { Message } from "./model";

type Listener = [EventTarget, string, (event: Event) => void];

type Out = Extract<Message, { _tag: "SubmittedSearch" | "ShowedPage" | "DetectedSharing" }>;

/**
 * The page behaviors that are about the browser, not the model: the creator picker closes on an outside click or
 * Escape, a search sends a busy state, and a page change skips the view transition unless it switches creators.
 * Runs once, when the page's root is in the document.
 */
export const PageBehaviors = Mount.defineStream("PageBehaviors", {
  messages: [Message.SubmittedSearch, Message.ShowedPage, Message.DetectedSharing],
  execute: ({ element }) =>
    Stream.callback<Out>((queue) =>
      Effect.gen(function* () {
        const listeners: Listener[] = [];

        const on = (target: EventTarget, type: string, f: (event: Event) => void) => {
          target.addEventListener(type, f);
          listeners.push([target, type, f]);
        };

        yield* Effect.addFinalizer(() => Effect.sync(() => listeners.forEach(([t, type, f]) => t.removeEventListener(type, f))));
        const emit = (message: Out) => void Queue.offerUnsafe(queue, message);

        const pick = element.querySelector<HTMLDetailsElement>(".pick");

        if (pick) {
          on(document, "click", (e) => { if (!pick.contains(e.target as Node)) pick.open = false; });
          on(pick, "keydown", (e) => {
            if ((e as KeyboardEvent).key !== "Escape" || !pick.open) return;
            pick.open = false;
            pick.querySelector("summary")?.focus();
          });
        }

        if (!element.querySelector(".search")) return;

        emit(Message.DetectedSharing({ hideCopy: Boolean(navigator.share) && matchMedia("(pointer: coarse)").matches }));

        for (const form of element.querySelectorAll("form")) on(form, "submit", () => emit(Message.SubmittedSearch()));
        let switchingCreator = false;
        on(window, "pageshow", () => {
          switchingCreator = false;
          emit(Message.ShowedPage());
        });
        on(window, "pageswap", (e) => { if (!switchingCreator) (e as Event & { viewTransition?: ViewTransition }).viewTransition?.skipTransition(); });

        for (const link of element.querySelectorAll(".pick .menu a")) on(link, "click", () => { switchingCreator = true; });
      }),
    ),
});
