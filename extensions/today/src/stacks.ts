/**
 * Stacked PRs: PRs that build on each other. A stack is worked by one session in one
 * worktree, so two sessions never fight over the same branches, and one session has the
 * context of how its PRs fit together. The board groups it under one Start button.
 *
 * - your own PRs (`my_pr`): chains of check-my-prs's `parent` (the open PR underneath).
 * - PRs you review (`review`): check-review-queue's `stack`, every open PR in the author's stack bottom
 *   first, including ones that already left your queue. Parent chains can't group these: a PR
 *   between two queued ones may be approved and gone from the board.
 *
 * - PRs ready to promote (`promote`): one group per app, oldest merge first, even an app with
 *   just one waiting. A promote ships them all, so one session ships the app.
 *
 * Pure, and shared by the server (launch) and the page (grouping).
 */

export interface StackMember {
  id: number;
  section: string;
  status: string;
  meta: Record<string, unknown> | null;
}

/** One PR of a review stack, as check-review-queue reports it (in your queue or not). */
export interface StackPr {
  number: number;
  title: string;
  url: string | null;
  inQueue: boolean;
}

/** The review queue's whole stack for a review item, bottom first; null when the PR stands alone. */
export function reviewStackOf(item: Pick<StackMember, "section" | "meta">): StackPr[] | null {
  if (item.section !== "review") return null;
  const stack = item.meta?.stack;
  if (!Array.isArray(stack) || stack.length < 2) return null;
  return stack as StackPr[];
}

function prOf(item: StackMember): { repo: string; number: number; parent: number | null } | null {
  if (item.section !== "my_pr" || item.status !== "open") return null;
  const repo = item.meta?.repo;
  const number = item.meta?.number;
  const parent = item.meta?.parent;
  if (typeof repo !== "string" || typeof number !== "number") return null;
  return { repo, number, parent: typeof parent === "number" ? parent : null };
}

/** your own PRs, grouped by parent chains. */
function ownStacks<T extends StackMember>(items: T[]): T[][] {
  const prs = new Map<string, { item: T; parent: number | null; number: number }>();
  for (const item of items) {
    const pr = prOf(item);
    if (pr) prs.set(`${pr.repo}#${pr.number}`, { item, parent: pr.parent, number: pr.number });
  }
  const repoOf = (key: string) => key.slice(0, key.lastIndexOf("#"));

  // The bottom of each PR's stack, and how far up it sits.
  const place = new Map<string, { root: string; depth: number }>();
  const locate = (key: string, seen: Set<string> = new Set()): { root: string; depth: number } => {
    const known = place.get(key);
    if (known) return known;
    const pr = prs.get(key)!;
    const parentKey = pr.parent === null ? null : `${repoOf(key)}#${pr.parent}`;
    let found = { root: key, depth: 0 };
    // A parent that isn't on the board (or a loop, which GitHub can't make) ends the chain here.
    if (parentKey && prs.has(parentKey) && !seen.has(parentKey)) {
      seen.add(key);
      const below = locate(parentKey, seen);
      found = { root: below.root, depth: below.depth + 1 };
    }
    place.set(key, found);
    return found;
  };

  const stacks = new Map<string, Array<{ item: T; depth: number; number: number }>>();
  for (const [key, pr] of prs) {
    const { root, depth } = locate(key);
    const stack = stacks.get(root) ?? [];
    stack.push({ item: pr.item, depth, number: pr.number });
    stacks.set(root, stack);
  }
  return [...stacks.values()]
    .filter((stack) => stack.length > 1)
    .map((stack) =>
      stack.sort((a, b) => a.depth - b.depth || a.number - b.number).map((entry) => entry.item),
    );
}

/** PRs you review, grouped by the bottom of the review queue's stack, in its order. */
function reviewStacks<T extends StackMember>(items: T[]): T[][] {
  const stacks = new Map<string, Array<{ item: T; position: number }>>();
  for (const item of items) {
    if (item.status !== "open") continue;
    const stack = reviewStackOf(item);
    if (!stack) continue;
    const key = `${String(item.meta?.repo)}#${stack[0]!.number}`;
    const position = stack.findIndex((pr) => pr.number === item.meta?.number);
    const group = stacks.get(key) ?? [];
    group.push({ item, position: position < 0 ? stack.length : position });
    stacks.set(key, group);
  }
  return [...stacks.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((a, b) => a.position - b.position).map((entry) => entry.item));
}

/** "acme/app:web" for an open PR waiting on that app's promote, else null. */
export function appOf(item: StackMember): string | null {
  if (item.section !== "promote" || item.status !== "open") return null;
  const { repo, app } = item.meta ?? {};
  return typeof repo === "string" && typeof app === "string" ? `${repo}:${app}` : null;
}

/** PRs ready to promote, one group per app, oldest merge first. */
export function appGroups<T extends StackMember>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const app = appOf(item);
    if (app) groups.set(app, [...(groups.get(app) ?? []), item]);
  }
  const merged = (item: T) => String(item.meta?.mergedAt ?? "");
  return [...groups.values()].map((group) =>
    group.sort((a, b) => merged(a).localeCompare(merged(b))),
  );
}

/**
 * Every group one session works, each ordered bottom first: PR stacks with two or more open
 * items on the board (the PR that merges first, then the ones built on it; PRs on their own
 * aren't returned), and each app's PRs ready to promote (even one).
 */
export function prStacks<T extends StackMember>(items: T[]): T[][] {
  return [...ownStacks(items), ...reviewStacks(items), ...appGroups(items)];
}

/** The stack an item belongs to on the board, bottom first; null when it stands alone. */
export function stackOf<T extends StackMember>(items: T[], item: { id: number }): T[] | null {
  return prStacks(items).find((stack) => stack.some((member) => member.id === item.id)) ?? null;
}
