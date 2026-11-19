/**
 * The last board the page loaded, so a page opens on it at once and refreshes behind it.
 *
 * Two layers: memory survives moving between Today pages (the SPA keeps this module), and
 * localStorage survives a fresh load (the Today app opening, a browser tab). A board from
 * another day is never shown: its "done today" and the morning's picks belong to that day.
 */

import { localDate } from "../nudge";
import type { ListResponse } from "./model";

const KEY = "anima:today:board";

/** The slice of `Storage` the cache uses, so tests can pass their own. */
export interface BoardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let memory: ListResponse | null = null;

function browserStorage(): BoardStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A private window or blocked site data throws on access.
    return null;
  }
}

/** The cached board, if it is today's; null when there is none or it went stale overnight. */
export function cachedBoard(
  now: Date = new Date(),
  storage: BoardStorage | null = browserStorage(),
): ListResponse | null {
  const today = localDate(now);
  if (memory?.date === today) return memory;
  memory = null;
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const board = JSON.parse(raw) as ListResponse;
    if (board?.date !== today || !Array.isArray(board.items)) {
      storage?.removeItem(KEY);
      return null;
    }
    memory = board;
    return board;
  } catch {
    return null;
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Keep a freshly loaded board. Memory at once; storage a moment later, since the board is a
 * few hundred KB and a burst of reloads (a collection pass, a row of clicks) needs one write.
 */
export function rememberBoard(
  board: ListResponse,
  storage: BoardStorage | null = browserStorage(),
  delayMs = 1_000,
): void {
  memory = board;
  if (!storage) return;
  if (pending) clearTimeout(pending);
  const write = () => {
    pending = null;
    try {
      storage.setItem(KEY, JSON.stringify(memory));
    } catch {
      // Over quota or blocked: memory still covers moving between pages.
    }
  };
  if (delayMs <= 0) write();
  else pending = setTimeout(write, delayMs);
}

/** Tests only: forget the in-memory board. */
export function forgetBoard(): void {
  memory = null;
  if (pending) clearTimeout(pending);
  pending = null;
}
