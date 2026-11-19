/**
 * How the ACTIVE pane arranges the queue: which rows nest under which, and
 * which top-level rows go in the collapsed Background group.
 *
 * Pure, so the rules can be tested without rendering the drawer.
 */

import type { ActiveSessionRow } from "./NavigationDrawer";

/**
 * The listed row each row nests under: its subagent parent when that is
 * listed, else the session that launched it when that is listed. A row whose
 * parent and launcher are both absent (resolved, snoozed) is top-level, so it
 * can't be lost.
 *
 * One exception: a row of the user's never nests under an automated launcher,
 * which would fold the user's session into Background. It stays a top-level
 * row of its own. (A subagent always stays with its parent.)
 *
 * Links that would form a loop are dropped, so every row still has a
 * top-level ancestor and is shown somewhere.
 */
export function nestParents(rows: readonly ActiveSessionRow[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.sessionId, row] as const));
  const parents = new Map<string, string>();
  for (const row of rows) {
    const launcher = row.launchedBySessionId ? byId.get(row.launchedBySessionId) : undefined;
    const parent =
      row.parentSessionId && byId.has(row.parentSessionId)
        ? row.parentSessionId
        : launcher && (isBackgroundRow(row) || !isBackgroundRow(launcher))
          ? launcher.sessionId
          : null;
    if (parent && parent !== row.sessionId) parents.set(row.sessionId, parent);
  }
  // Break loops: walk up from each row; meeting itself again means the row
  // is on a cycle, and dropping its own link roots the cycle there.
  for (const row of rows) {
    const seen = new Set<string>([row.sessionId]);
    let current = parents.get(row.sessionId);
    while (current !== undefined) {
      if (seen.has(current)) {
        parents.delete(row.sessionId);
        break;
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
  return parents;
}

/**
 * The queue in display order: each nested row directly under the row it
 * nests in, siblings in the server's order.
 */
export function nestSessions(rows: readonly ActiveSessionRow[]): ActiveSessionRow[] {
  const parents = nestParents(rows);
  const children = new Map<string, ActiveSessionRow[]>();
  for (const row of rows) {
    const parent = parents.get(row.sessionId);
    if (!parent) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  const ordered: ActiveSessionRow[] = [];
  const place = (row: ActiveSessionRow) => {
    ordered.push(row);
    for (const child of children.get(row.sessionId) ?? []) place(child);
  };
  for (const row of rows) {
    if (!parents.has(row.sessionId)) place(row);
  }
  return ordered;
}

/** A top-level row and everything nested beneath it, at any depth. */
export interface ActiveGroup {
  row: ActiveSessionRow;
  nested: ActiveSessionRow[];
}

/**
 * The queue as top-level rows, each carrying every row nested beneath it
 * (subagents and launched sessions, in `nestSessions` order), so the pane can
 * fold them behind one row per piece of work.
 */
export function groupNested(rows: readonly ActiveSessionRow[]): ActiveGroup[] {
  const parents = nestParents(rows);
  const groups: ActiveGroup[] = [];
  for (const row of nestSessions(rows)) {
    const current = groups[groups.length - 1];
    if (parents.has(row.sessionId) && current) current.nested.push(row);
    else groups.push({ row, nested: [] });
  }
  return groups;
}

/**
 * Does this row belong in Background? An automated session nobody pinned.
 * Asked of top-level rows (a launched session nests under its launcher
 * wherever that is), and of a launcher before a row of the user's nests in it.
 */
export function isBackgroundRow(row: ActiveSessionRow): boolean {
  return row.origin === "automated" && !row.pinned;
}

/** The user's groups first, in server order, and the Background groups after. */
export function splitBackground(groups: readonly ActiveGroup[]): {
  foreground: ActiveGroup[];
  background: ActiveGroup[];
} {
  const foreground: ActiveGroup[] = [];
  const background: ActiveGroup[] = [];
  for (const group of groups) (isBackgroundRow(group.row) ? background : foreground).push(group);
  return { foreground, background };
}

/** How the fold under a row reads: "2 subagents", "1 launched", "1 subagent · 2 launched". */
export function nestedLabel(nested: readonly ActiveSessionRow[], running: number): string {
  const subagents = nested.filter((row) => Boolean(row.parentSessionId)).length;
  const launched = nested.length - subagents;
  const parts: string[] = [];
  if (subagents > 0) parts.push(subagents === 1 ? "1 subagent" : `${subagents} subagents`);
  if (launched > 0) parts.push(`${launched} launched`);
  if (running > 0 && running < nested.length) parts.push(`${running} running`);
  return parts.join(" · ");
}
