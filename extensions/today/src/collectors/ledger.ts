/**
 * Promise ledger collector: an example source, not a feature you need. It reads a JSON file
 * that something else keeps up to date (a scheduled sweep of your chat threads, a script, you
 * by hand) and puts its open promises on the board. The board only reads it.
 *
 * The shape, keyed by any stable id (a chat thread's channel and timestamp works well):
 *
 *   {
 *     "last_scan": "2023-11-15T13:00:00Z",
 *     "threads": {
 *       "C0123:1700000000.000100": {
 *         "status": "open",                // only "open" entries are collected
 *         "title": "Send Jordan the export numbers",
 *         "permalink": "https://chat.example.com/archives/C0123/p1700000000000100",
 *         "where": "#data-team",           // shown as the item's state chip
 *         "asker": "jordan",               // who is waiting on you
 *         "note": "Promised by Friday",
 *         "ticket": "ENG-123",             // optional: a ticket that tracks it (snoozes with it)
 *         "since": "2023-11-14T22:13:20Z", // optional: when it was asked (else read from the key)
 *         "last_seen_ts": "1700000300.1"   // optional: last activity, as a Unix-seconds string
 *       }
 *     }
 *   }
 *
 * Only `open` entries are collected: promises still owed with no ticket of their own (a reply,
 * a one-minute action). Promises that got a ticket can carry your Linear promise label and
 * arrive through the Linear collector instead.
 */

import { readFile } from "node:fs/promises";
import type { CollectedItem } from "../store";

export interface LedgerEntry {
  status: string;
  permalink?: string;
  where?: string;
  note?: string;
  ticket?: string | null;
  title?: string;
  asker?: string;
  since?: string;
  decided_at?: string;
  last_seen_ts?: string;
}

export interface Ledger {
  last_scan?: string;
  threads: Record<string, LedgerEntry>;
}

/** A Unix-seconds timestamp string ("1700000000.000100", a chat thread's ts) → ISO. */
export function slackTsToIso(ts: string | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

export function ledgerToItems(ledger: Ledger): CollectedItem[] {
  return Object.entries(ledger.threads)
    .filter(([, entry]) => entry.status === "open")
    .map(([key, entry]) => ({
      key: `slack:${key}`,
      section: "promise" as const,
      title: entry.title ?? entry.note ?? `Thread in ${entry.where ?? "a DM"}`,
      url: entry.permalink ?? null,
      waitingOn: entry.asker ?? null,
      stateLabel: entry.where ?? null,
      since: entry.since ?? slackTsToIso(key.split(":")[1]),
      sourceUpdatedAt: slackTsToIso(entry.last_seen_ts),
      meta: { ledgerKey: key, note: entry.note ?? null, ticket: entry.ticket ?? null },
    }));
}

export async function collectLedger(path: string): Promise<CollectedItem[]> {
  const ledger = JSON.parse(await readFile(path, "utf8")) as Ledger;
  if (!ledger.threads || typeof ledger.threads !== "object") {
    throw new Error(`${path} has no threads map`);
  }
  return ledgerToItems(ledger);
}
