/**
 * The Start button's dialog: what's about to start, plus a box for your note ("I did this on
 * Friday, close it as kept"), which goes into the session's first prompt. Empty is fine: Start
 * then launches exactly as before. The Reviews page's "Review all" opens it for the review queue.
 */

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Layers, Play, RotateCw } from "lucide-react";
import { reviewStackOf } from "../stacks";
import type { TodayData } from "./ui";

export function LaunchDialog({ today }: { today: TodayData }) {
  const item = today.pendingLaunch;
  const queue = today.pendingQueue;
  const open = Boolean(item ?? queue);
  const dialog = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [context, setContext] = useState("");

  // showModal() gives us the backdrop, Esc and a focus trap; the dialog follows the pending item.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      box.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  const close = () => {
    setContext("");
    today.cancelLaunch();
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    today.confirmLaunch(context);
    setContext("");
  };
  // Enter is a new line (notes run long, and phones have no other way to break one); ⌘/Ctrl+Enter starts.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
  };

  const review = item ? reviewStackOf(item) : null;
  const stackSize = item ? (review?.length ?? today.stackOf(item)?.length) : undefined;
  const follow = today.pendingFollow && Boolean(item);
  const heading = follow
    ? "Pick it back up"
    : queue
      ? "Run the review queue"
      : stackSize
        ? review
          ? "Review the stack"
          : "Work the stack"
        : "Start a session";
  const projects = queue ? [...new Set(queue.map((i) => i.project))].join(", ") : item?.project;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="today-launch-heading"
      onClose={close}
      // A click on the backdrop lands on the dialog itself, outside the card.
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] max-w-none border-0 bg-transparent p-0 text-[var(--ink)] backdrop:bg-[#2d2622]/30 backdrop:backdrop-blur-[2px]"
    >
      {open && (
        <form onSubmit={submit} className="today-card rounded-2xl px-5 pb-4 pt-5">
          <h2 id="today-launch-heading" className="today-display text-lg font-semibold">
            {heading}
          </h2>
          {queue ? (
            <p className="mt-1 text-[15px] leading-snug">
              {queue.length} {queue.length === 1 ? "review" : "reviews"}, one after another: I pick
              the order, then each PR (or stack) gets a fresh session that hands off to the next.
            </p>
          ) : (
            <p className="mt-1 text-[15px] leading-snug">
              {item?.title}
              {follow && item?.stateLabel ? (
                <span className="text-[var(--muted)]"> · {item.stateLabel}</span>
              ) : null}
            </p>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--muted)]">
            {stackSize || queue ? <Layers size={12} className="shrink-0" /> : null}
            {projects}
            {follow
              ? " · back to its session"
              : stackSize
                ? ` · one session for all ${stackSize} PRs`
                : ""}
            {queue ? " · running-review-sessions" : ""}
          </p>
          <label
            htmlFor="today-launch-context"
            className="today-hand mt-4 block text-xl leading-tight"
          >
            Anything I should know first?
          </label>
          <textarea
            id="today-launch-context"
            ref={box}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            onKeyDown={onKeyDown}
            rows={4}
            maxLength={4000}
            placeholder="Optional. e.g. “I already did this on Friday, close it out as a promise kept.”"
            className="mt-1.5 block w-full resize-y rounded-xl border border-[var(--line)] bg-white/80 px-3 py-2 text-[15px] leading-snug outline-none placeholder:text-[var(--muted)] focus:border-[#9dbcf9] focus:ring-2 focus:ring-[#dce8fe]"
          />
          <div className="mt-3 flex items-center gap-2">
            <span className="hidden text-xs text-[var(--muted)] sm:inline">
              ⌘↩ to {follow ? "continue" : "start"}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={close}
              className="rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-[var(--muted)] hover:bg-[#f1ece6] hover:text-[var(--ink)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-[#2f6fe0]"
            >
              {follow ? (
                <RotateCw size={11} strokeWidth={2.5} />
              ) : (
                <Play size={11} strokeWidth={2.5} className="fill-current" />
              )}
              {follow ? "Continue" : "Start"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
