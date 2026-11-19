/**
 * Snoozing: a Linear ticket you don't plan to touch yet leaves the board until a date, or
 * until you unsnooze it. The snooze lives in Linear (`Issue.snoozedUntilAt`, settable on any
 * issue, not just triage), so the board keeps no state of its own: the collector reads it back
 * into `meta.snoozedUntil`. A ledger promise with a ticket snoozes through that ticket. Pure, and
 * shared by the server and the page.
 */

/** "Until I unsnooze": Linear needs a date, so a far one. */
export const SNOOZE_FOREVER = "2099-01-01T00:00:00.000Z";

interface Snoozable {
  key: string;
  meta: Record<string, unknown> | null;
}

/** The Linear issue that holds an item's snooze: its own, or its promise's ticket. Null: can't. */
export function snoozeTicket(item: Snoozable): string | null {
  const identifier = item.meta?.identifier;
  if (item.key.startsWith("linear:") && typeof identifier === "string") return identifier;
  const ticket = item.meta?.ticket;
  return typeof ticket === "string" && /^[A-Z][A-Z0-9]*-\d+$/.test(ticket) ? ticket : null;
}

/** Snoozed until this time, if that's still ahead of `now`. */
export function snoozedUntil(item: Snoozable, now: Date = new Date()): string | null {
  const until = item.meta?.snoozedUntil;
  if (typeof until !== "string") return null;
  return Date.parse(until) > now.getTime() ? until : null;
}

/**
 * Items as the board shows them: a promise with a ticket takes its ticket's snooze (the ledger,
 * where the promise comes from, knows nothing of Linear).
 */
export function withSnoozes<T extends Snoozable>(items: T[]): T[] {
  const byTicket = new Map<string, string>();
  for (const item of items) {
    const until = item.meta?.snoozedUntil;
    const identifier = item.meta?.identifier;
    if (
      item.key.startsWith("linear:") &&
      typeof identifier === "string" &&
      typeof until === "string"
    ) {
      byTicket.set(identifier, until);
    }
  }
  return items.map((item) => {
    if (item.key.startsWith("linear:")) return item;
    const ticket = snoozeTicket(item);
    const until = ticket ? byTicket.get(ticket) : undefined;
    return until ? { ...item, meta: { ...item.meta, snoozedUntil: until } } : item;
  });
}

/** "snoozed · Nov 24", or just "snoozed" when it's until you unsnooze. */
export function snoozeText(until: string): string {
  if (until >= SNOOZE_FOREVER) return "snoozed";
  const day = new Date(until).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `snoozed · ${day}`;
}

export type SnoozeChoice = "day" | "week" | "month" | "forever";

export const SNOOZE_CHOICES: Array<{ choice: SnoozeChoice; label: string }> = [
  { choice: "day", label: "Until tomorrow" },
  { choice: "week", label: "For a week" },
  { choice: "month", label: "For a month" },
  { choice: "forever", label: "Until I unsnooze" },
];

/** When a choice ends: 6 AM local on that day, so it's back before you start. */
export function snoozeDate(choice: SnoozeChoice, now: Date = new Date()): string {
  if (choice === "forever") return SNOOZE_FOREVER;
  const at = new Date(now);
  at.setHours(6, 0, 0, 0);
  if (choice === "day") at.setDate(at.getDate() + 1);
  if (choice === "week") at.setDate(at.getDate() + 7);
  if (choice === "month") at.setMonth(at.getMonth() + 1);
  return at.toISOString();
}

/** The Linear mutation that sets (or clears, with null) an issue's snooze. `id` takes "ENG-123". */
export const SNOOZE_MUTATION =
  "mutation($id: String!, $at: DateTime) { issueUpdate(id: $id, input: { snoozedUntilAt: $at }) { success issue { snoozedUntilAt } } }";
