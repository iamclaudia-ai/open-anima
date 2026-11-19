/**
 * Your agent's short notes on each category page: a nudge when there's work in it, a pat on
 * the back when it's clear. The overview's note comes from the morning sweep (`today.set_note`);
 * these are canned, one picked at random per visit, never the same one twice in a row. Edit
 * them freely: they're meant to sound like your team.
 */

import type { Section } from "./model";

/** A note, or one that mentions how many items there are (only used for 2 or more). */
type Line = string | ((n: number) => string);

interface Pool {
  busy: Line[];
  clear: Line[];
}

export const NOTES: Record<Section, Pool> = {
  my_pr: {
    busy: [
      "Merge the green ones first. A clean board feels good. 🚀",
      (n) => `${n} PRs of yours are open. One at a time.`,
      "A PR waiting on you is a teammate waiting on you.",
      "Rebase, re-run, merge. You know the routine.",
      "Small ones first? Momentum is real.",
      "Ship it before it goes stale. Future you will be glad.",
      "If CI is red, start a session and I'll dig into why.",
    ],
    clear: [
      "None of your PRs need you right now.",
      "Nothing of yours is stuck. Nice work.",
      "Every PR is moving. Good time for a coffee. ☕",
      "All quiet on the PR front. Time to open a new one?",
    ],
  },
  review: {
    busy: [
      "Someone's waiting on your review. A quick one today helps more than a perfect one later. 👀",
      (n) => `${n} reviews waiting. Oldest first is a good rule.`,
      "Tap Review all and I'll draft a first pass for each. You make the calls and post them.",
      "A review today beats a perfect review on Friday.",
      "Your teammates ship faster when reviews don't sit.",
    ],
    clear: [
      "Your review queue is clear.",
      "Review queue is clear. Your team owes you a coffee. ☕",
      "Not a single review waiting.",
      "Clean queue. I'll flag it here the moment someone needs you.",
    ],
  },
  ticket: {
    busy: [
      "Pick one, finish it, then the next. 🎫",
      (n) => `${n} tickets on deck. Not all of them today, just the next one.`,
      "Start the one you've been avoiding. It's rarely as bad as it looks.",
      "Want help with one? Tap Start and I'll open a session and get going.",
      "Due dates first, then whatever unblocks someone else.",
      "Every ticket you close is one less thing on your mind.",
    ],
    clear: [
      "Nothing due soon or in progress.",
      "No tickets pressing right now.",
      "Clear for now. Maybe peek at what's next in the phase?",
      "Nothing due. You're ahead.",
    ],
  },
  promise: {
    busy: [
      "Promises are what people remember. Let's keep them. 🤝",
      (n) => `${n} people are waiting on something you said you'd do.`,
      'A quick "still on it" message counts as keeping your word too.',
      "Oldest promise first. It's been waiting the longest.",
      "Close the loop and tell them it's done. That part matters as much as the doing.",
    ],
    clear: [
      "Nothing owed.",
      "Every promise kept.",
      "Your word is good, and today it's all paid up.",
      "No promises pending. Careful what you say yes to next. 😏",
    ],
  },
  promote: {
    busy: [
      "Merged isn't shipped. Let's get your work in front of people. 🚢",
      (n) => `${n} PRs are waiting for a promote.`,
      "Your fixes are done. They just need a ride to production.",
      "Nothing helps anyone until it's live.",
      "Holding one back on purpose? That's fine, it'll wait here.",
    ],
    clear: [
      "Production has everything you merged.",
      "Production has all your work. ✨",
      "Nothing waiting. Everything you merged is live.",
      "All shipped. Go tell someone about it.",
    ],
  },
};

/** What the coffee cup says while the very first board loads, in turn. */
export const LOADING_LINES = [
  "Pouring your coffee…",
  "Peeking at your PRs…",
  "Checking your tickets…",
  "Counting your wins…",
  "Sorting your to-do list…",
  "Almost there…",
];

const lastShown = new Map<Section, string>();

/** The note a category page showed last time, for `sectionNote`'s `avoid`. */
export function lastNote(section: Section): string | undefined {
  return lastShown.get(section);
}

/** Remember what a page showed, so its next visit picks another. */
export function noteShown(section: Section, note: string): void {
  lastShown.set(section, note);
}

/**
 * A note for a category page. `count` is what needs you there (0 = clear); `seed` in [0, 1)
 * picks one, so a page keeps its note across re-renders and gets a new one on the next visit.
 * `avoid` (the last visit's note) is skipped, so the same one never shows twice in a row.
 */
export function sectionNote(section: Section, count: number, seed: number, avoid?: string): string {
  const pool = count > 0 ? NOTES[section].busy : NOTES[section].clear;
  const lines = pool
    .filter((line) => typeof line === "string" || count >= 2)
    .map((line) => (typeof line === "string" ? line : line(count)));
  let index = Math.min(Math.floor(seed * lines.length), lines.length - 1);
  if (lines.length > 1 && lines[index] === avoid) index = (index + 1) % lines.length;
  return lines[index]!;
}
