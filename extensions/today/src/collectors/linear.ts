/**
 * Linear collector (optional): every open issue assigned to you, read straight from Linear's
 * GraphQL API with your API key, paged. Off unless a key is configured (see config.ts).
 *
 * All of them are collected, not just the urgent ones, so that "missing from
 * the collection" reliably means closed or reassigned. The page decides what
 * to show (due soon, in progress, high priority, the current phase) and counts
 * the rest. Issues carrying the promise label land in the promise section.
 *
 * Active projects and phases come from Linear itself, never from Anima:
 * a project you have **favorited** (and that isn't completed or canceled) is
 * active, and its **current phase** is the earliest milestone (by `sortOrder`)
 * that still has an open issue of yours. Issues outside any milestone are in no
 * phase: a planning session puts them in one.
 */

import type { CollectedItem } from "../store";

export const LINEAR_API = "https://api.linear.app/graphql";

/** One GraphQL request to Linear: resolves to `data`, throws on an HTTP or GraphQL error. */
export type LinearGraphql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/** A Linear client for an API key (personal keys go in `Authorization` as they are). */
export function linearClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): LinearGraphql {
  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetchImpl(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: { data?: T; errors?: { message?: string }[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Linear answered ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.ok || body.errors?.length || !body.data) {
      const messages = body.errors?.map((e) => e.message).join("; ");
      throw new Error(`Linear answered ${response.status}: ${messages || text.slice(0, 200)}`);
    }
    return body.data;
  };
}

const QUERY = `query($after: String) {
  favorites(first: 100) { nodes { type project { id state } } }
  viewer {
    assignedIssues(first: 100, after: $after,
      filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        identifier title url dueDate updatedAt createdAt priority priorityLabel snoozedUntilAt
        state { name type }
        labels { nodes { name } }
        project { id name }
        projectMilestone { name sortOrder }
        cycle { number startsAt endsAt }
      }
    }
  }
}`;

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  dueDate: string | null;
  updatedAt: string;
  createdAt: string;
  priority: number;
  priorityLabel: string;
  /** Snoozed in Linear until then (the board's Snooze button sets it). */
  snoozedUntilAt?: string | null;
  state: { name: string; type: string };
  labels: { nodes: { name: string }[] };
  project: { id?: string; name: string } | null;
  projectMilestone?: { name: string; sortOrder: number } | null;
  cycle: { number: number; startsAt: string; endsAt: string } | null;
}

interface Page {
  favorites?: { nodes: { type: string; project: { id: string; state: string } | null }[] };
  viewer: {
    assignedIssues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearIssue[];
    };
  };
}

/** Where an issue stands in your plan: its project is active, and it's in the current phase. */
export interface PlanPlace {
  activeProject: boolean;
  currentPhase: boolean;
}

const NO_PLACE: PlanPlace = { activeProject: false, currentPhase: false };

/** Favorited projects that are still going (a finished project stays favorited by accident). */
export function activeProjectIds(favorites: Page["favorites"]): Set<string> {
  const ids = new Set<string>();
  for (const node of favorites?.nodes ?? []) {
    if (node.type !== "project" || !node.project) continue;
    if (node.project.state === "completed" || node.project.state === "canceled") continue;
    ids.add(node.project.id);
  }
  return ids;
}

/**
 * Each active project's current phase: the lowest milestone `sortOrder` among the open issues
 * given (all of them yours). Returns a placer for any issue.
 */
export function planPlacer(
  issues: LinearIssue[],
  active: Set<string>,
): (issue: LinearIssue) => PlanPlace {
  const current = new Map<string, number>();
  for (const issue of issues) {
    const project = issue.project?.id;
    const order = issue.projectMilestone?.sortOrder;
    if (!project || !active.has(project) || order === undefined) continue;
    current.set(project, Math.min(order, current.get(project) ?? Infinity));
  }
  return (issue) => {
    const project = issue.project?.id;
    if (!project || !active.has(project)) return NO_PLACE;
    const order = issue.projectMilestone?.sortOrder;
    return {
      activeProject: true,
      currentPhase: order !== undefined && current.get(project) === order,
    };
  };
}

export function issueToItem(
  issue: LinearIssue,
  promiseLabel: string,
  place: PlanPlace = NO_PLACE,
): CollectedItem {
  const labels = issue.labels.nodes.map((l) => l.name);
  return {
    key: `linear:${issue.identifier}`,
    section: labels.includes(promiseLabel) ? "promise" : "ticket",
    title: `${issue.identifier} ${issue.title}`,
    url: issue.url,
    stateLabel: issue.state.name,
    since: issue.createdAt,
    dueDate: issue.dueDate,
    sourceUpdatedAt: issue.updatedAt,
    meta: {
      identifier: issue.identifier,
      stateType: issue.state.type,
      // Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      snoozedUntil: issue.snoozedUntilAt ?? null,
      project: issue.project?.name ?? null,
      milestone: issue.projectMilestone?.name ?? null,
      milestoneOrder: issue.projectMilestone?.sortOrder ?? null,
      activeProject: place.activeProject,
      currentPhase: place.currentPhase,
      cycle: issue.cycle,
      labels,
    },
  };
}

export async function collectLinear(
  linear: LinearGraphql,
  options: { promiseLabel: string },
): Promise<CollectedItem[]> {
  const issues: LinearIssue[] = [];
  let active: Set<string> | null = null;
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: Page = await linear<Page>(QUERY, { after });
    active ??= activeProjectIds(data.favorites);
    const { nodes, pageInfo } = data.viewer.assignedIssues;
    issues.push(...nodes);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) {
      const place = planPlacer(issues, active);
      return issues.map((issue) => issueToItem(issue, options.promiseLabel, place(issue)));
    }
    after = pageInfo.endCursor;
  }
  throw new Error("More than 1000 assigned Linear issues; refusing a partial collection");
}
