#!/usr/bin/env bun
/**
 * Today Extension — the user's morning board (/today).
 *
 * One list of what wants the user's attention across projects: promises owed,
 * PRs waiting on their review, their own PRs in review, tickets assigned to them,
 * and their merged PRs that production doesn't have yet (Ready to promote, one
 * group per app, see collectors/deploys.ts), plus the top few picked for today.
 *
 * Each item's Start button (`today.launch`) opens a new agent session
 * already prompted to work on it, and remembers it so the page can link back.
 * When one of their PRs needs work again after that session finished (a review
 * comment, an AI reviewer on the new push, conflicts with a moved main), each
 * collection sends the session back to it; Continue (`today.follow_up`) does
 * the same by hand (follow-up.ts).
 *
 * Human in the loop: sessions do the work on this machine, then stop and ask on the board
 * before anything leaves it (push, merge, post, deploy; `approvals` in config.ts, all on by
 * default). The board itself never pushes, merges, posts or sends: the Nudge button only
 * copies a draft for the user to post.
 *
 * Collectors re-read GitHub (the scripts in ../tools), Linear (optional) and a promise
 * ledger (optional) every `intervalMinutes` (default 5) and reconcile (store.ts), so closed
 * tickets and merged PRs clear themselves. The page also asks for a refresh when it comes into
 * view and every 2 minutes while visible (`maxAgeSeconds` skips a fresh one). Judgment work
 * (picking today's top things, the morning note) is done by a scheduled agent session through
 * these methods (`today.set_top`, `today.set_note`).
 */

import { Database } from "bun:sqlite";
import { animaDataDir } from "@anima/shared";
import { join } from "node:path";
import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@anima/shared";
import { z } from "zod";
import { collectDeploys, type DeployCache, newDeployCache } from "./collectors/deploys";
import { type DiscoveredRepos, discoverRepos } from "./collectors/discovery";
import { collectMyPrs, collectReviews } from "./collectors/github";
import { isRateLimited, readGithubBudget } from "./collectors/github-budget";
import { collectLedger } from "./collectors/ledger";
import { collectLinear, type LinearGraphql, linearClient } from "./collectors/linear";
import { runCommand, type RunCommand } from "./collectors/run";
import {
  linearKey,
  localDate,
  parseTodayConfig,
  type ProjectConfig,
  type TodayConfig,
} from "./config";
import {
  launchFolder,
  launchPrompt,
  launchTitle,
  planStackLaunch,
  stackFolder,
  stackPrompt,
  stackTitle,
} from "./launch";
import { type BoardSummary, liveBoard } from "./board";
import {
  autoFollowUps,
  followUpKey,
  followUpPrompt,
  followUpsToReset,
  type LiveSession,
  sessionBusy,
} from "./follow-up";
import { canNudge, nudgeMessage } from "./nudge";
import { createAsking, NEEDS_YOU_EVENT, type StatusChange } from "./questions";
import {
  planReviewQueues,
  type ReviewQueuePlan,
  reviewQueuePrompt,
  reviewQueueTitle,
} from "./review-queue";
import { SNOOZE_MUTATION, snoozeTicket, withSnoozes } from "./snooze";
import { reviewStackOf, stackOf } from "./stacks";
import {
  addItem,
  applyCollection,
  type CollectedItem,
  type CollectionResult,
  followHandoff,
  getItem,
  finishedSessions,
  linkStackSessions,
  setNudged,
  listItems,
  patchMeta,
  setPinned,
  setSession,
  setStatus,
  getNote,
  resetFollowUps,
  setFollowedUp,
  setNote,
  setTop,
  type TodayItem,
} from "./store";

const SectionSchema = z.enum(["promise", "review", "my_pr", "ticket", "promote"]);

const RefSchema = z
  .object({
    id: z.number().int().optional().describe("Item id"),
    key: z.string().optional().describe("Item key, e.g. linear:ENG-123 or review:acme/app#12"),
  })
  .refine((ref) => ref.id !== undefined || ref.key !== undefined, "Pass id or key");

const ByField = z
  .enum(["user", "agent"])
  .default("user")
  .describe("Who decided: user (the page) or agent (a session)");

const ListSchema = z.object({
  doneSince: z.string().optional().describe("Also include items finished since this ISO time"),
  project: z.string().optional(),
  section: SectionSchema.optional(),
  status: z.enum(["open", "done", "dismissed", "all"]).optional().describe("Default open"),
  doneBy: z.enum(["user", "agent", "collector"]).optional(),
});

const SetStatusSchema = RefSchema.and(
  z.object({ by: ByField, note: z.string().max(500).optional() }),
);

const PinSchema = RefSchema.and(z.object({ pinned: z.boolean().default(true) }));

const SnoozeSchema = RefSchema.and(
  z.object({
    until: z
      .string()
      .datetime()
      .nullable()
      .describe("Snoozed until this ISO time (2099-01-01 for 'until I unsnooze'); null unsnoozes"),
  }),
);

const LaunchSchema = RefSchema.and(
  z.object({
    restart: z
      .boolean()
      .default(false)
      .describe("Start a fresh session even if this item already has one"),
    context: z
      .string()
      .max(4000)
      .optional()
      .describe(
        "The user's note for the session, from the Start dialog: it goes into the first prompt, ahead of the standing steps",
      ),
  }),
);

const FollowUpSchema = RefSchema.and(
  z.object({
    context: z
      .string()
      .max(4000)
      .optional()
      .describe("The user's note for the session, from the Continue dialog"),
  }),
);

const ReviewQueueSchema = z.object({
  project: z
    .string()
    .min(1)
    .optional()
    .describe("Only this project's reviews (default: every project with reviews waiting)"),
  context: z
    .string()
    .max(4000)
    .optional()
    .describe("The user's note for the queue session, from the Start dialog"),
});

const AskSchema = RefSchema.and(
  z.object({
    question: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "What only the user can answer (or a go they must give), in one or two sentences they can reply to",
      ),
  }),
);

const BoardSchema = z.object({});

const SetNoteSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Local date (default today)"),
  text: z
    .string()
    .min(1)
    .max(600)
    .describe("The agent's morning note to the user: short, friendly, the shape of their day"),
});

const SetTopSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Local date the picks are for (default today)"),
  picks: z
    .array(z.object({ key: z.string(), reason: z.string().max(300).optional() }))
    .max(25)
    .describe(
      "The day's ranked queue, most important first; replaces any picks for that date. The board shows the first 5 that are the user's to act on right now, so rank everything worth doing (up to 25)",
    ),
});

const AddItemSchema = z.object({
  key: z.string().optional().describe("Stable key to update later (default manual:<random>)"),
  project: z.string().min(1),
  section: SectionSchema.default("promise"),
  title: z.string().min(1).max(300),
  url: z.string().url().optional(),
  waitingOn: z.string().max(120).optional().describe("Who is waiting on the user"),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  since: z.string().optional().describe("When the ask started (ISO); default now"),
  note: z.string().max(500).optional(),
});

const RefreshSchema = z.object({
  project: z.string().optional(),
  maxAgeSeconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Skip if every source was collected within this many seconds (the page's automatic refresh). Omit to always collect.",
    ),
});

interface CollectionStatus {
  at: string;
  ok: boolean;
  count?: number;
  result?: Omit<CollectionResult, "closedIds">;
  error?: string;
}

/**
 * Was every named source collected within `maxAgeMs`? A source that failed recently counts as fresh
 * too: retrying it on every page focus would only hammer whatever is down.
 */
export function collectedWithin(
  sources: string[],
  statuses: ReadonlyMap<string, { at: string }>,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  return sources.every((name) => {
    const at = statuses.get(name)?.at;
    return at !== undefined && nowMs - Date.parse(at) <= maxAgeMs;
  });
}

interface Source {
  name: string;
  /** Spends GitHub GraphQL points: throttled, and paused when the budget runs low. */
  github?: boolean;
  /** Collected at most this often instead of every `githubIntervalMinutes` (a GitHub source). */
  intervalMs?: number;
  /** A discovered repo that has nothing open any more: collected empty once, to close its items. */
  stale?: boolean;
  collect: () => Promise<CollectedItem[]>;
}

/** GitHub collection standing aside until the hour's GraphQL budget refills. */
export interface GithubPause {
  until: string;
  remaining: number;
}

/** Collected this recently, with a little slack so a 5-minute timer doesn't skip every other run. */
export function collectedSince(at: string | undefined, nowMs: number, intervalMs: number): boolean {
  return at !== undefined && nowMs - Date.parse(at) < intervalMs - 30_000;
}

/**
 * A project's sources. GitHub ones cover its fixed `repos` plus, with an org, the repos discovery
 * last found something open in (`discovered`, see collectors/discovery.ts).
 */
export function projectSources(
  project: ProjectConfig,
  run: RunCommand,
  discovered?: DiscoveredRepos,
  deploys: { cache: DeployCache; now: () => Date } = {
    cache: newDeployCache(),
    now: () => new Date(),
  },
  /** The project's Linear client, when Linear is on for it (a key is set). */
  linear?: LinearGraphql | null,
): Source[] {
  const sources: Source[] = [];
  if (project.linear && linear) {
    const { promiseLabel } = project.linear;
    sources.push({
      name: `${project.name}:linear`,
      collect: () => collectLinear(linear, { promiseLabel }),
    });
  }
  const fixed = project.github?.repos ?? [];
  const union = (found: string[] = []) => [...new Set([...fixed, ...found])];
  if (project.github && project.github.reviews !== false) {
    for (const repo of union(discovered?.reviews)) {
      sources.push({
        name: `${project.name}:reviews:${repo}`,
        github: true,
        collect: () => collectReviews(run, { cwd: project.cwd, repo }),
      });
    }
  }
  if (project.github && project.github.mine !== false) {
    for (const repo of union(discovered?.mine)) {
      sources.push({
        name: `${project.name}:mine:${repo}`,
        github: true,
        collect: () => collectMyPrs(run, { cwd: project.cwd, repo }),
      });
    }
  }
  const deployCheck = project.github?.deploys;
  if (project.github && deployCheck) {
    const { repos, org } = project.github;
    sources.push({
      name: `${project.name}:deploys`,
      github: true,
      intervalMs: deployCheck.intervalMinutes * 60_000,
      collect: () =>
        collectDeploys(run, {
          cwd: project.cwd,
          repos,
          org,
          days: deployCheck.days,
          graceHours: deployCheck.graceHours,
          now: deploys.now(),
          cache: deploys.cache,
        }),
    });
  }
  if (project.promiseLedger) {
    const path = project.promiseLedger;
    sources.push({ name: `${project.name}:ledger`, collect: () => collectLedger(path) });
  }
  return sources;
}

export interface TodayDeps {
  openDb?: () => Database;
  run?: RunCommand;
  now?: () => Date;
  /** Makes the Linear client for an API key (tests pass a fake; default: the real API). */
  linear?: (apiKey: string) => LinearGraphql;
  /** Where the Linear key falls back to (default process.env). */
  env?: Record<string, string | undefined>;
}

export function createTodayExtension(
  rawConfig: Record<string, unknown> = {},
  deps: TodayDeps = {},
): AnimaExtension {
  const config: TodayConfig = parseTodayConfig(rawConfig);
  const run = deps.run ?? runCommand;
  const now = deps.now ?? (() => new Date());
  const makeLinear = deps.linear ?? ((apiKey: string) => linearClient(apiKey));
  /** One client per key, made on first use. */
  const linearClients = new Map<string, LinearGraphql>();
  function linearFor(project: ProjectConfig): LinearGraphql | null {
    const key = linearKey(config, project, deps.env);
    if (!key) return null;
    let client = linearClients.get(key);
    if (!client) linearClients.set(key, (client = makeLinear(key)));
    return client;
  }
  let ctx: ExtensionContext | null = null;
  let db: Database | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let phoneTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  let collecting: Promise<void> | null = null;
  /** Items whose session is being started: a double tap must not start two. */
  const launching = new Set<number>();
  const statuses = new Map<string, CollectionStatus>();
  /** Projects whose GitHub collection waits for the GraphQL budget to refill. */
  const githubPauses = new Map<string, GithubPause>();
  /** Each org project's last successful discovery: which repos have anything open. */
  const discovered = new Map<string, { at: string; repos: DiscoveredRepos }>();
  const githubIntervalMs = config.githubIntervalMinutes * 60_000;
  /** Deploy check state that outlives a pass: repos' apps, commits' PRs (collectors/deploys.ts). */
  const deployCache = newDeployCache();

  function getDb(): Database {
    if (db) return db;
    if (deps.openDb) {
      db = deps.openDb();
      return db;
    }
    // Resolved on first use, never at import: tests must not reach ~/.anima.
    db = new Database(join(animaDataDir(), "anima.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  function changed(reason: string): void {
    ctx?.emit("today.changed", { reason, at: now().toISOString() });
  }

  const asking = createAsking({
    db: getDb,
    call: (method, params) => {
      if (!ctx) return Promise.reject(new Error("Today isn't running"));
      return ctx.call(method, params);
    },
    emit: (event, payload) => ctx?.emit(event, payload),
    changed,
    warn: (message, meta) => ctx?.log.warn(message, meta),
    now,
  });

  /**
   * May this GitHub source run now? Not if it ran within `githubIntervalMinutes` (unless forced:
   * the Refresh button), and never while the GraphQL budget is low: then it waits for the reset.
   */
  async function githubAllowed(
    project: ProjectConfig,
    source: Source,
    force: boolean,
    budget: { checked: boolean },
  ): Promise<boolean> {
    const nowMs = now().getTime();
    const pause = githubPauses.get(project.name);
    if (pause && nowMs < Date.parse(pause.until)) return false;
    if (
      !force &&
      collectedSince(statuses.get(source.name)?.at, nowMs, source.intervalMs ?? githubIntervalMs)
    ) {
      return false;
    }
    if (!budget.checked) {
      budget.checked = true;
      await checkBudget(project);
    }
    return !githubPauses.has(project.name);
  }

  /** Read the budget; pause GitHub collection until the reset when it's below the reserve. */
  async function checkBudget(project: ProjectConfig): Promise<void> {
    try {
      const budget = await readGithubBudget(run, project.cwd);
      if (budget.remaining >= config.githubReserve) {
        githubPauses.delete(project.name);
        return;
      }
      githubPauses.set(project.name, { until: budget.resetAt, remaining: budget.remaining });
      ctx?.log.warn("GitHub budget low: pausing GitHub collection until the reset", {
        project: project.name,
        remaining: budget.remaining,
        until: budget.resetAt,
      });
    } catch (error) {
      // Can't tell: go ahead, and let a rate-limited collection pause it instead.
      ctx?.log.warn("Couldn't read the GitHub budget", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Find the org's repos with anything open for the user, at most every `githubIntervalMinutes`
   * (unless forced). True only when a search ran and succeeded this pass: only then may repos
   * that dropped out have their items closed.
   */
  async function discover(project: ProjectConfig, force: boolean): Promise<boolean> {
    const org = project.github?.org;
    if (!org) return false;
    const name = `${project.name}:discovery`;
    const nowMs = now().getTime();
    if (!force && collectedSince(discovered.get(project.name)?.at, nowMs, githubIntervalMs)) {
      return false;
    }
    const at = now().toISOString();
    try {
      const repos = await discoverRepos(run, { cwd: project.cwd, org });
      discovered.set(project.name, { at, repos });
      statuses.set(name, { at, ok: true, count: new Set([...repos.mine, ...repos.reviews]).size });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.set(name, { at, ok: false, error: message });
      ctx?.log.warn("Repo discovery failed", { project: project.name, error: message });
      return false;
    }
  }

  /** GitHub sources with open items that discovery no longer lists: their repos have nothing open. */
  function staleSources(project: ProjectConfig, current: Source[]): Source[] {
    const names = new Set(current.map((source) => source.name));
    const rows = getDb()
      .query<{ source: string }, [string, string, string]>(
        `SELECT DISTINCT source FROM today_items
         WHERE status = 'open' AND (source LIKE ? OR source LIKE ?) AND project = ?`,
      )
      .all(`${project.name}:mine:%`, `${project.name}:reviews:%`, project.name);
    return rows
      .filter((row) => !names.has(row.source))
      .map((row) => ({ name: row.source, stale: true, collect: async () => [] }));
  }

  /** `closed` collects the ids of the items this pass closes. */
  async function collectProject(
    project: ProjectConfig,
    force: boolean,
    closed: number[],
  ): Promise<boolean> {
    let any = false;
    const budget = { checked: false };
    const fresh = await discover(project, force);
    const sources = projectSources(
      project,
      run,
      discovered.get(project.name)?.repos,
      { cache: deployCache, now },
      linearFor(project),
    );
    if (fresh) sources.push(...staleSources(project, sources));
    for (const source of sources) {
      if (source.github && !(await githubAllowed(project, source, force, budget))) continue;
      const at = now().toISOString();
      try {
        const items = await source.collect();
        const { closedIds, ...result } = applyCollection(
          getDb(),
          source.name,
          project.name,
          items,
          at,
        );
        closed.push(...closedIds);
        if (source.stale) statuses.delete(source.name);
        else statuses.set(source.name, { at, ok: true, count: items.length, result });
        if (result.added + result.reopened + result.completed > 0) any = true;
      } catch (error) {
        // A failed collection changes nothing: no item is completed for
        // going missing from a source we couldn't read.
        const message = error instanceof Error ? error.message : String(error);
        statuses.set(source.name, { at, ok: false, error: message });
        ctx?.log.warn("Collection failed", { source: source.name, error: message });
        // Out of budget anyway: stand aside until the reset instead of failing every pass.
        if (source.github && isRateLimited(message)) await checkBudget(project);
      }
    }
    return any;
  }

  /** The pause still in effect, if any (the page says why GitHub items aren't moving). */
  function activePause(): GithubPause | null {
    const nowMs = now().getTime();
    return [...githubPauses.values()].find((pause) => nowMs < Date.parse(pause.until)) ?? null;
  }

  /** `force`: collect GitHub sources even if they ran recently (the Refresh button). */
  function collectAll(projectName?: string, force = false): Promise<void> {
    if (collecting) return collecting;
    collecting = (async () => {
      let any = false;
      const closed: number[] = [];
      for (const project of config.projects) {
        if (projectName && project.name !== projectName) continue;
        if (await collectProject(project, force, closed)) any = true;
      }
      if (linkStackSessions(getDb(), now().toISOString()) > 0) any = true;
      await finishSessions(closed);
      await followUp();
      // Field updates (state labels, titles) also matter to an open page.
      changed(any ? "collected" : "refreshed");
    })().finally(() => {
      collecting = null;
    });
    return collecting;
  }

  /**
   * A session whose items have all closed (the PR merged, the review posted, the ticket done, or
   * ticked off by hand) has finished its work: mark it done, so it leaves the user's Active list.
   * Only on the close itself, so a session they pick back up stays open; prompting it reopens it.
   */
  async function finishSessions(closedIds: number[]): Promise<void> {
    const host = ctx;
    if (!host || closedIds.length === 0) return;
    for (const sessionId of finishedSessions(getDb(), closedIds)) {
      try {
        await host.call("session.set_status", { sessionId, disposition: "resolved" });
        host.log.info("Today: marked a finished session done", { sessionId });
      } catch (error) {
        host.log.warn("Today: couldn't mark a finished session done", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Send sessions back to the user's PRs that moved on after they finished (see follow-up.ts).
   * Runs after each collection; never when the attention queue can't be read (it can't tell
   * who's busy). The prompt carries the approval gates, so a session sent back prepares the fix
   * and asks before pushing or replying.
   */
  async function followUp(): Promise<void> {
    const host = ctx;
    if (!host) return;
    const items = listItems(getDb());
    resetFollowUps(getDb(), followUpsToReset(items));
    const live = await attentionSessions();
    if (!live) return;
    const at = now().toISOString();
    for (const { sessionId, items: members } of autoFollowUps(items, live, now().getTime())) {
      setFollowedUp(
        getDb(),
        members.map((item) => ({ id: item.id, key: followUpKey(item) })),
        at,
        true,
      );
      host.log.info("Today: sent a session back to its PR", {
        sessionId,
        items: members.map((item) => `${item.key} (${item.stateLabel ?? ""})`),
      });
      prompt(
        host,
        members[0]!.key,
        sessionId,
        followUpPrompt(members, { auto: true, approvals: config.approvals }),
      );
    }
  }

  /** Send a session its prompt in the background: it waits server-side for a worktree. */
  function prompt(host: ExtensionContext, key: string, sessionId: string, content: string): void {
    void host
      .call("session.send_prompt", { sessionId, content, streaming: true })
      .catch((error: unknown) =>
        host.log.error(`Today: ${key}'s session didn't get its prompt`, {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /** Start (or reuse) the session for one item. */
  async function launchItem(
    host: ExtensionContext,
    item: TodayItem,
    project: ProjectConfig,
    context?: string,
  ): Promise<{ item: TodayItem; started: boolean }> {
    const folder = launchFolder(item, project);
    // create_session answers at once, even while a worktree is still being made (a minute
    // or two in a big repo), so the page links the session right away. The prompt waits for the
    // worktree on the server, so it goes out in the background.
    const session = (await host.call("session.create_session", {
      ...folder,
      title: launchTitle(item),
      // The user starts these and works in them: their ACTIVE list rather than Background.
      // Under the default "yolo" profile the prompt's approval gates are what keep pushes,
      // merges, posts and deploys waiting for the user's go (`sessionProfile` in config.ts).
      profile: config.sessionProfile,
      origin: "user",
    })) as { sessionId: string; workspaceId: string };
    const updated = setSession(getDb(), item.id, session, now().toISOString());
    changed("today.launch");
    prompt(
      host,
      item.key,
      session.sessionId,
      launchPrompt(item, folder.worktree, context, config.approvals),
    );
    return { item: updated, started: true };
  }

  /**
   * One session for a whole PR stack: the one already working it, else the bottom-most PR's
   * session (told the rest is its now), else a new one in the bottom PR's worktree.
   */
  async function launchStack(
    host: ExtensionContext,
    item: TodayItem,
    members: TodayItem[],
    project: ProjectConfig,
    restart: boolean,
    context?: string,
  ): Promise<{ item: TodayItem; started: boolean; stack: number }> {
    const plan = planStackLaunch(members, restart);
    if (plan.kind === "existing") return { item, started: false, stack: members.length };
    const bottom = members[0]!;
    const link = (session: { sessionId: string; workspaceId: string }) => {
      const at = now().toISOString();
      for (const member of members) setSession(getDb(), member.id, session, at, true);
      changed("today.launch");
    };

    if (plan.kind === "adopt") {
      link(plan.session);
      await host
        .call("session.set_title", {
          sessionId: plan.session.sessionId,
          title: stackTitle(members),
        })
        .catch(() => undefined);
      const content = stackPrompt(members, {
        adopted: true,
        others: plan.others,
        context,
        approvals: config.approvals,
      });
      prompt(host, bottom.key, plan.session.sessionId, content);
      return { item: getItem(getDb(), item.id)!, started: false, stack: members.length };
    }

    const folder = stackFolder(members, project);
    const session = (await host.call("session.create_session", {
      ...folder,
      title: stackTitle(members),
      profile: config.sessionProfile,
      origin: "user",
    })) as { sessionId: string; workspaceId: string };
    link(session);
    const content = stackPrompt(members, {
      worktree: folder.worktree,
      others: plan.others,
      context,
      approvals: config.approvals,
    });
    prompt(host, bottom.key, session.sessionId, content);
    return { item: getItem(getDb(), item.id)!, started: true, stack: members.length };
  }

  /** One project's review queue: a session in its main checkout (each review makes its own worktree). */
  async function launchReviewQueue(
    host: ExtensionContext,
    plan: ReviewQueuePlan,
    project: ProjectConfig,
    context?: string,
  ): Promise<{ project: string; sessionId: string; workspaceId: string; queued: number }> {
    const session = (await host.call("session.create_session", {
      cwd: project.cwd,
      title: reviewQueueTitle(project.name),
      profile: config.sessionProfile,
      origin: "user",
    })) as { sessionId: string; workspaceId: string };
    const at = now().toISOString();
    for (const item of plan.queued) setSession(getDb(), item.id, session, at);
    changed("today.review_queue");
    prompt(
      host,
      `${project.name}'s review queue`,
      session.sessionId,
      reviewQueuePrompt({
        queued: plan.queued,
        taken: plan.taken,
        context,
        approvals: config.approvals,
      }),
    );
    return { project: project.name, ...session, queued: plan.queued.length };
  }

  /** Sessions still in the user's Active list (the attention queue), by id; null if unreadable. */
  async function attentionSessions(): Promise<Map<string, LiveSession> | null> {
    if (!ctx) return null;
    try {
      const result = (await ctx.call("session.list_attention", {})) as {
        sessions?: Array<LiveSession & { sessionId: string }>;
      };
      return new Map((result.sessions ?? []).map((s) => [s.sessionId, s] as const));
    } catch (error) {
      ctx.log.warn("Couldn't read the attention queue", { error: String(error) });
      return null;
    }
  }

  /** Sessions still in the user's Active list; none (no session counts as working) if unreadable. */
  async function liveSessions(): Promise<Set<string>> {
    return new Set((await attentionSessions())?.keys() ?? []);
  }

  /** The board as the page shows it right now (see board.ts). */
  async function board(): Promise<BoardSummary> {
    return liveBoard(withSnoozes(listItems(getDb())), {
      date: localDate(now(), config.timeZone),
      now: now(),
      live: await liveSessions(),
    });
  }

  const READ = { lane: "read", concurrency: "parallel" } as const;
  const methods: ExtensionMethodDefinition[] = [
    {
      name: "today.list",
      description:
        "The board's items: open by default; doneSince also returns items finished since then. Includes today's local date and each source's last collection.",
      inputSchema: ListSchema,
      // Reads never queue behind a collection or a launch (the page waited up to 30s).
      execution: READ,
    },
    {
      name: "today.board",
      description:
        "The live board as /today shows it: the top 5 picks (the morning's ranked queue, keeping what's the user's to act on or being worked now, topped up from the board's own ranking), everything waiting on someone else (with nudges due), the questions sessions asked the user, how much of the queue is still moving, and which picks the current note was written over (`notePicks`).",
      inputSchema: BoardSchema,
      execution: READ,
    },
    {
      name: "today.refresh",
      description:
        "Re-collect GitHub, Linear and promise-ledger items now (all projects or one; Linear and the ledger only where configured)",
      inputSchema: RefreshSchema,
      // collectAll shares one pass in flight, like the interval timer that runs outside the
      // queue, so a pin or snooze never waits on GitHub.
      execution: { lane: "control", concurrency: "parallel" },
    },
    {
      name: "today.complete",
      description:
        "Mark an item done. It stays done until its source changes after this moment (a new reply, a re-request).",
      inputSchema: SetStatusSchema,
    },
    {
      name: "today.dismiss",
      description: "Drop an item that isn't the user's to do (same reopen rule as complete)",
      inputSchema: SetStatusSchema,
    },
    {
      name: "today.reopen",
      description: "Put a done or dismissed item back on the list",
      inputSchema: SetStatusSchema,
    },
    {
      name: "today.pin",
      description: "Pin an item to the top section (or unpin with pinned=false)",
      inputSchema: PinSchema,
    },
    {
      name: "today.snooze",
      description:
        "Snooze a Linear ticket (or a promise with a ticket) until a time, or unsnooze it with until=null. The snooze is set in Linear itself (snoozedUntilAt, with the project's Linear API key) when the user asks for it (the page's Snooze button), so the board keeps no state of its own; a snoozed item leaves the picks and headlines until then.",
      inputSchema: SnoozeSchema,
    },
    {
      name: "today.launch",
      description:
        "Start a new agent session in the item's project (in its own worktree when the project asks for one), prompted to work on it (plus the user's `context` note, when given) and to stop and ask before anything the `approvals` gates cover (push, merge, post, deploy: all by default), and remember it on the item. Returns the existing session instead when there is one, unless restart. A PR in a stack starts one session for the whole stack (in the bottom PR's worktree), or hands the whole stack to the session already working part of it.",
      inputSchema: LaunchSchema,
    },
    {
      name: "today.follow_up",
      description:
        "Send an item's session back to it (the Continue button): prompts the session it already has, with every open item it works (a whole stack) and its current state, plus the user's `context` note. Reopens a session marked done. The board also does this by itself after a collection when one of the user's PRs needs work again (conflicts, failing checks, new review comments) and its session has finished; the prompt carries the same approval gates.",
      inputSchema: FollowUpSchema,
    },
    {
      name: "today.review_queue",
      description:
        "Start one review-queue session per project (in its main checkout) that works through every open review without a session, one PR or stack at a time, chaining sessions by handoff. With the `post` gate on (the default) it drafts each review for the user to post and posts nothing. Links those reviews to it; the links follow each handoff.",
      inputSchema: ReviewQueueSchema,
    },
    {
      name: "today.nudge",
      description:
        "The user nudges reviewers about one of their PRs waiting on review: returns a drafted message (`draft`, Markdown) and the project's `reviewChannel` for the user to post themselves, and records when, so the board counts the days since. Posts nothing anywhere.",
      inputSchema: RefSchema,
    },
    {
      name: "today.ask",
      description:
        "A session working an item needs the user (a go for a push, merge, post or deploy; a decision; a clarification; anything only they can answer): shows the question under the item, turns its session pill red and marks the session blocked, and pops a notification in their open Anima tabs. notify.send delivers it if it's still unanswered after 10 minutes. Cleared by itself when the user's next message reaches the session. Ask, then end your turn.",
      inputSchema: AskSchema,
    },
    {
      name: "today.set_top",
      description:
        "Set today's top picks (ordered, with a one-line reason each), replacing earlier picks for that date. A PR nudged within the last 3 days waits on reviewers, so it is left out and listed under `quiet`. Used by the morning sweep and the day refresh.",
      inputSchema: SetTopSchema,
    },
    {
      name: "today.set_note",
      description:
        "Leave the agent's note at the top of /today (one per local date, replaces that date's note; the morning sweep writes it, the day refresh rewrites it once the board has moved on). Records the live top picks it was written over, so call it after set_top.",
      inputSchema: SetNoteSchema,
    },
    {
      name: "today.add_item",
      description:
        "Add or update (by key) an item no collector owns, such as a promise that isn't in the ledger",
      inputSchema: AddItemSchema,
    },
    {
      name: "today.health_check",
      description: "Collector status per source",
      inputSchema: z.object({}),
      execution: READ,
    },
  ];
  const schemas = new Map(methods.map((m) => [m.name, m.inputSchema]));

  return {
    id: "today",
    name: "Today",
    methods,
    events: ["today.changed", NEEDS_YOU_EVENT],

    async start(context: ExtensionContext) {
      ctx = context;
      getDb();
      const intervalMs = config.intervalMinutes * 60_000;
      timer = setInterval(() => void collectAll(), intervalMs);
      void collectAll();
      // Questions: answered when the user's next message reaches the session; unanswered ones go to notify.
      const offStatus = ctx.on("session.status_changed", (event) => {
        void asking.onStatus(event.payload as StatusChange);
      });
      // A session that hands off takes its items with it (`session.<id>.handoff`).
      const offHandoff = ctx.on("session.*.handoff", (event) => {
        const payload = event.payload as {
          sessionId?: string;
          targetSessionId?: string;
          workspaceId?: string;
        };
        if (!payload.sessionId || !payload.targetSessionId || !payload.workspaceId) return;
        const moved = followHandoff(
          getDb(),
          payload.sessionId,
          { sessionId: payload.targetSessionId, workspaceId: payload.workspaceId },
          now().toISOString(),
        );
        if (moved > 0) changed("today.handoff");
      });
      unsubscribeStatus = () => {
        offStatus();
        offHandoff();
      };
      phoneTimer = setInterval(() => void asking.phoneSweep(), 60_000);
      ctx.log.info("Today started", {
        projects: config.projects.map((p) => p.name),
        intervalMinutes: config.intervalMinutes,
      });
    },

    async stop() {
      if (timer) clearInterval(timer);
      if (phoneTimer) clearInterval(phoneTimer);
      timer = phoneTimer = null;
      unsubscribeStatus?.();
      unsubscribeStatus = null;
      await collecting?.catch(() => undefined);
      db?.close();
      db = null;
      ctx = null;
    },

    async handleMethod(method: string, rawParams: Record<string, unknown>) {
      // The extension host doesn't validate params yet: parse here so defaults apply.
      const schema = schemas.get(method);
      const params = (schema ? schema.parse(rawParams) : rawParams) as Record<string, unknown>;
      const at = now().toISOString();
      const ref = (p: { id?: number; key?: string }) =>
        p.id !== undefined ? p.id : (p.key as string);

      switch (method) {
        case "today.list": {
          const p = params as z.infer<typeof ListSchema>;
          const date = localDate(now(), config.timeZone);
          const note = getNote(getDb(), date);
          return {
            date,
            timeZone: config.timeZone,
            note: note?.text ?? null,
            noteUpdatedAt: note?.updatedAt ?? null,
            items: withSnoozes(listItems(getDb(), p)),
            collections: Object.fromEntries(statuses),
            githubPaused: activePause(),
          };
        }
        case "today.refresh": {
          const p = params as z.infer<typeof RefreshSchema>;
          const sources = config.projects
            .filter((project) => !p.project || project.name === p.project)
            .flatMap((project) =>
              projectSources(project, run, discovered.get(project.name)?.repos).map(
                (source) => source.name,
              ),
            );
          const fresh =
            p.maxAgeSeconds !== undefined &&
            collectedWithin(sources, statuses, now().getTime(), p.maxAgeSeconds * 1000);
          // Asked for by hand (no maxAgeSeconds): GitHub too, even if it ran a minute ago.
          if (!fresh) await collectAll(p.project, p.maxAgeSeconds === undefined);
          return { skipped: fresh, collections: Object.fromEntries(statuses) };
        }
        case "today.complete":
        case "today.dismiss":
        case "today.reopen": {
          const p = params as z.infer<typeof SetStatusSchema>;
          const status =
            method === "today.complete"
              ? "done"
              : method === "today.dismiss"
                ? "dismissed"
                : "open";
          const item = setStatus(getDb(), ref(p), status, p.by, at, p.note);
          if (status !== "open") await finishSessions([item.id]);
          changed(method);
          return item;
        }
        case "today.pin": {
          const p = params as z.infer<typeof PinSchema>;
          const item = setPinned(getDb(), ref(p), p.pinned, at);
          changed(method);
          return item;
        }
        case "today.snooze": {
          const p = params as z.infer<typeof SnoozeSchema>;
          const item = getItem(getDb(), ref(p));
          if (!item) throw new Error(`No today item ${ref(p)}`);
          const identifier = snoozeTicket(item);
          if (!identifier) {
            throw new Error(`${item.key} has no Linear ticket, and snoozes live in Linear`);
          }
          const project = config.projects.find((candidate) => candidate.name === item.project);
          const linear = project ? linearFor(project) : null;
          if (!linear) throw new Error(`Linear isn't configured for project ${item.project}`);
          const answer = await linear<{ issueUpdate?: { success?: boolean } }>(SNOOZE_MUTATION, {
            id: identifier,
            at: p.until,
          });
          if (!answer.issueUpdate?.success) {
            throw new Error(
              `Linear didn't snooze ${identifier}: ${JSON.stringify(answer).slice(0, 300)}`,
            );
          }
          // Show it now; the next Linear collection reads the same thing back.
          const patch = { snoozedUntil: p.until };
          const ticket = getItem(getDb(), `linear:${identifier}`);
          if (ticket) patchMeta(getDb(), ticket.id, patch, at);
          const updated = patchMeta(getDb(), item.id, patch, at);
          changed(method);
          return updated;
        }
        case "today.nudge": {
          // Drafts only: the user posts it themselves (the page copies it to the clipboard).
          const item = getItem(getDb(), ref(params as z.infer<typeof RefSchema>));
          if (!item) throw new Error(`No today item ${ref(params as z.infer<typeof RefSchema>)}`);
          if (!canNudge(item)) throw new Error(`${item.key} isn't a PR of yours waiting on review`);
          const project = config.projects.find((candidate) => candidate.name === item.project);
          const updated = setNudged(getDb(), item.id, at);
          changed(method);
          return {
            item: updated,
            draft: nudgeMessage(item),
            channel: project?.reviewChannel ?? null,
          };
        }
        case "today.launch": {
          const p = params as z.infer<typeof LaunchSchema>;
          const item = getItem(getDb(), ref(p));
          if (!item) throw new Error(`No today item ${ref(p)}`);
          // A stacked PR is worked with the rest of its stack, by one session. A review whose
          // stack has only it on the board still gets the stack's session: the rest is context.
          const stack = stackOf(listItems(getDb()), item) ?? (reviewStackOf(item) ? [item] : null);
          if (!stack && item.sessionId && !p.restart) return { item, started: false };
          const project = config.projects.find((candidate) => candidate.name === item.project);
          if (!project) throw new Error(`No Today project named ${item.project} to start it in`);
          const host = ctx;
          if (!host) throw new Error("Today isn't running");
          const ids = (stack ?? [item]).map((member) => member.id);
          if (ids.some((id) => launching.has(id))) {
            throw new Error("Already starting a session for this item");
          }
          for (const id of ids) launching.add(id);
          try {
            return stack
              ? await launchStack(host, item, stack, project, p.restart === true, p.context)
              : await launchItem(host, item, project, p.context);
          } finally {
            for (const id of ids) launching.delete(id);
          }
        }
        case "today.follow_up": {
          const p = params as z.infer<typeof FollowUpSchema>;
          const item = getItem(getDb(), ref(p));
          if (!item) throw new Error(`No today item ${ref(p)}`);
          if (!item.sessionId) throw new Error(`${item.key} has no session yet: start one instead`);
          const host = ctx;
          if (!host) throw new Error("Today isn't running");
          const live = await attentionSessions();
          if (sessionBusy(live?.get(item.sessionId))) {
            throw new Error("Its session is working right now");
          }
          // The rest of its stack, worked by the same session, comes along in the one prompt.
          const stack = stackOf(listItems(getDb()), item) ?? [item];
          const all = stack.filter((member) => member.sessionId === item.sessionId);
          if (!all.some((member) => member.id === item.id)) all.unshift(item);
          setFollowedUp(
            getDb(),
            all.map((member) => ({ id: member.id, key: followUpKey(member) })),
            at,
            false,
          );
          prompt(
            host,
            item.key,
            item.sessionId,
            followUpPrompt(all, { auto: false, context: p.context, approvals: config.approvals }),
          );
          changed(method);
          return { item: getItem(getDb(), item.id), sessionId: item.sessionId };
        }
        case "today.review_queue": {
          const p = params as z.infer<typeof ReviewQueueSchema>;
          const plans = planReviewQueues(listItems(getDb()), p.project);
          if (plans.length === 0) throw new Error("No reviews waiting without a session");
          const host = ctx;
          if (!host) throw new Error("Today isn't running");
          const projects = plans.map((plan) => {
            const project = config.projects.find((candidate) => candidate.name === plan.project);
            if (!project) throw new Error(`No Today project named ${plan.project} to start it in`);
            return project;
          });
          const ids = plans.flatMap((plan) => plan.queued.map((item) => item.id));
          if (ids.some((id) => launching.has(id))) {
            throw new Error("Already starting a session for one of these reviews");
          }
          for (const id of ids) launching.add(id);
          try {
            const started = [];
            for (const [index, plan] of plans.entries()) {
              started.push(await launchReviewQueue(host, plan, projects[index]!, p.context));
            }
            return { started };
          } finally {
            for (const id of ids) launching.delete(id);
          }
        }
        case "today.ask": {
          const p = params as z.infer<typeof AskSchema>;
          const item = getItem(getDb(), ref(p));
          if (!item) throw new Error(`No today item ${ref(p)}`);
          if (item.status !== "open") throw new Error(`${item.key} is ${item.status}, not open`);
          return await asking.ask(item, p.question.trim());
        }
        case "today.set_top": {
          const p = params as z.infer<typeof SetTopSchema>;
          const date = p.date ?? localDate(now(), config.timeZone);
          const result = setTop(getDb(), date, p.picks, at);
          changed(method);
          return { date, ...result };
        }
        case "today.board": {
          const live = await board();
          const note = getNote(getDb(), live.date);
          return {
            ...live,
            noteUpdatedAt: note?.updatedAt ?? null,
            notePicks: note?.picks ?? null,
          };
        }
        case "today.set_note": {
          const p = params as z.infer<typeof SetNoteSchema>;
          const date = p.date ?? localDate(now(), config.timeZone);
          const picks = (await board()).picks.map((pick) => pick.key);
          setNote(getDb(), date, p.text, at, picks);
          changed(method);
          return { date };
        }
        case "today.add_item": {
          const item = addItem(getDb(), params as z.infer<typeof AddItemSchema>, at);
          changed(method);
          return item;
        }
        case "today.health_check": {
          const entries = [...statuses.entries()];
          const failing = entries.filter(([, s]) => !s.ok);
          const response: HealthCheckResponse = {
            ok: true,
            status: failing.length > 0 ? "degraded" : "healthy",
            label: "Today",
            metrics: [
              { label: "Projects", value: config.projects.length },
              { label: "Sources", value: entries.length },
              { label: "Failing", value: failing.length },
              {
                label: "GitHub",
                value: activePause()
                  ? `paused until ${new Date(activePause()!.until).toLocaleTimeString()}`
                  : "collecting",
              },
              { label: "Open items", value: listItems(getDb()).length },
            ],
            items: entries.map(([name, s]) => ({
              id: name,
              label: name,
              status: s.ok ? "healthy" : "dead",
              details: (s.ok
                ? {
                    at: s.at,
                    count: String(s.count ?? 0),
                    changes: s.result
                      ? `+${s.result.added} ↺${s.result.reopened} ✓${s.result.completed}`
                      : "",
                  }
                : { at: s.at, error: s.error ?? "" }) as Record<string, string>,
            })),
          };
          return response;
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      const failing = [...statuses.values()].filter((s) => !s.ok).length;
      return { ok: true, details: { projects: config.projects.length, failing } };
    },
  };
}

export default createTodayExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createTodayExtension);
