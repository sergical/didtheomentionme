import { Effect, Queue, Stream } from "effect";
import * as Mount from "foldkit/mount";
import { Message } from "./model";

type Out = Extract<Message, { _tag: "SubmittedSearch" | "ShowedPage" | "DetectedSharing" }>;

/** Listens until the scope closes: every listener takes `signal`, and the finalizer aborts it. */
const behaviors = (element: Element, emit: (message: Out) => void) =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const { signal } = controller;

    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

    const pick = element.querySelector<HTMLDetailsElement>(".pick");

    if (pick) {
      document.addEventListener("click", (e) => { if (!(e.target instanceof Node && pick.contains(e.target))) pick.open = false; }, { signal });
      pick.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !pick.open) return;
        pick.open = false;
        pick.querySelector("summary")?.focus();
      }, { signal });
    }

    if (!element.querySelector(".search")) return;

    emit(Message.DetectedSharing({ hideCopy: Boolean(navigator.share) && matchMedia("(pointer: coarse)").matches }));

    for (const form of element.querySelectorAll("form")) form.addEventListener("submit", () => emit(Message.SubmittedSearch()), { signal });
    let switchingCreator = false;
    window.addEventListener("pageshow", () => {
      switchingCreator = false;
      emit(Message.ShowedPage());
    }, { signal });
    window.addEventListener("pageswap", (e) => { if (!switchingCreator) e.viewTransition?.skipTransition(); }, { signal });

    for (const link of element.querySelectorAll(".pick .menu a")) link.addEventListener("click", () => { switchingCreator = true; }, { signal });
  });

/**
 * The page behaviors that are about the browser, not the model: the creator picker closes on an outside click or
 * Escape, a search sends a busy state, and a page change skips the view transition unless it switches creators.
 * Runs once, when the page's root is in the document.
 */
export const PageBehaviors = Mount.defineStream("PageBehaviors", {
  messages: [Message.SubmittedSearch, Message.ShowedPage, Message.DetectedSharing],
  execute: ({ element }) => Stream.callback<Out>((queue) => behaviors(element, (message) => void Queue.offerUnsafe(queue, message))),
});
