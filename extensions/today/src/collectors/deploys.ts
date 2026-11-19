/**
 * Your merged PRs that aren't in production yet. A merged PR isn't done until it's live, and an
 * app whose promote nobody runs can drift weeks behind main without anyone noticing.
 *
 * It assumes one release convention (adapt this file to yours), and reads everything from the
 * repo itself, so there's no app list to keep current:
 * - **Apps**: each `.github/workflows/<app>-deploy-prod.yml` (a manual promote workflow). Its
 *   `path-filters` input says which paths the app ships; `.` or none means
 *   the whole repo. A repo without one (a library, a docker setup) has nothing to check.
 * - **Production**: the newest `<app>-prod-vN` tag, which the release workflow cuts.
 * - **Your merges**: your commits on the default branch touching the app's paths, each mapped to
 *   the PR that brought it in: a squash names it (`(#N)`), and so does a merge (`Merge pull
 *   request #N`). GitHub's path history drops a merge commit whose branch side matches it, so a
 *   true merge often shows up only as its branch commits: those are looked up once
 *   (`commits/<sha>/pulls`) and remembered.
 *
 * Per app, newest first, each merge older than the grace period is compared with the prod tag;
 * the first one production contains ends the walk, since everything merged before it shipped
 * with it. Only REST calls, plus one GraphQL point per repo for the tags.
 */

import type { CollectedItem } from "../store";
import type { RunCommand } from "./run";

export interface DeployApp {
  /** "web": the workflow's and the prod tags' prefix */
  name: string;
  workflow: string;
  /** Path prefixes it ships; empty means the whole repo */
  paths: string[];
}

export interface RepoApps {
  branch: string;
  apps: DeployApp[];
}

/** A merge on the default branch that names its PR. */
export interface PrMerge {
  sha: string;
  number: number;
  title: string;
  mergedAt: string;
}

/** A commit on the default branch, as the path history lists it. */
export interface BranchCommit {
  sha: string;
  date: string;
  message: string;
}

/** What survives between passes: apps change rarely; a commit's PR and your login never. */
export interface DeployCache {
  apps: Map<string, { at: number; value: RepoApps }>;
  login: Map<string, string>;
  /** `<repo>@<sha>` → the PR it merged with (null: none merged into the default branch). */
  prs: Map<string, Promise<PrMerge | null>>;
}

export function newDeployCache(): DeployCache {
  return { apps: new Map(), login: new Map(), prs: new Map() };
}

/** Workflows are re-read this often. */
export const APPS_TTL_MS = 6 * 60 * 60_000;

const WORKFLOW = /^(.+)-deploy-prod\.ya?ml$/;

// ── Parsing ──────────────────────────────────────────────────

/** The promote action's `path-filters: 'a/,b/'`; `.` (or none) is the whole repo. */
export function parsePathFilters(yaml: string): string[] {
  const match = yaml.match(/^\s*path-filters:\s*['"]?([^'"\n#]*)['"]?\s*$/m);
  if (!match) return [];
  const paths = match[1]!
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  return paths.some((path) => path === "." || path === "./") ? [] : paths;
}

/** The PR a commit on the default branch merged, or null for anything else. */
export function prOfCommit(message: string): { number: number; title: string } | null {
  const lines = message.split("\n");
  const first = lines[0]!.trim();
  const merge = first.match(/^Merge pull request #(\d+) from \S+/);
  if (merge) {
    // GitHub puts the PR's title in the paragraph after.
    const title =
      lines
        .slice(1)
        .find((line) => line.trim())
        ?.trim() ?? first;
    return { number: Number(merge[1]), title };
  }
  const squash = first.match(/^(.*\S)\s+\(#(\d+)\)$/);
  return squash ? { number: Number(squash[2]), title: squash[1]! } : null;
}

/** The highest `<app>-prod-vN` among some tag names (a substring query also finds other apps'). */
export function newestProdTag(app: string, names: string[]): string | null {
  const pattern = new RegExp(`^${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-prod-v(\\d+)$`);
  let best: { name: string; n: number } | null = null;
  for (const name of names) {
    const n = Number(name.match(pattern)?.[1]);
    if (Number.isFinite(n) && (!best || n > best.n)) best = { name, n };
  }
  return best?.name ?? null;
}

// ── GitHub reads ─────────────────────────────────────────────

const notFound = (error: unknown) => error instanceof Error && /HTTP 404/.test(error.message);

/** The repo's default branch and its deployable apps. A repo without workflows has none. */
export async function readRepoApps(run: RunCommand, cwd: string, repo: string): Promise<RepoApps> {
  const branch = (
    await run(["gh", "api", `repos/${repo}`, "--jq", ".default_branch"], { cwd })
  ).trim();
  let files: string[];
  try {
    const stdout = await run(
      ["gh", "api", `repos/${repo}/contents/.github/workflows`, "--jq", ".[].name"],
      { cwd },
    );
    files = stdout.split("\n").filter(Boolean);
  } catch (error) {
    if (notFound(error)) return { branch, apps: [] };
    throw error;
  }
  const apps: DeployApp[] = [];
  for (const workflow of files) {
    const name = workflow.match(WORKFLOW)?.[1];
    if (!name) continue;
    const yaml = await run(
      [
        "gh",
        "api",
        `repos/${repo}/contents/.github/workflows/${workflow}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ],
      { cwd },
    );
    apps.push({ name, workflow, paths: parsePathFilters(yaml) });
  }
  return { branch, apps };
}

/** Each app's newest prod tag, in one GraphQL query. Apps that never shipped are left out. */
export async function readProdTags(
  run: RunCommand,
  cwd: string,
  repo: string,
  apps: DeployApp[],
): Promise<Map<string, string>> {
  const [owner, name] = repo.split("/");
  const fields = apps
    .map(
      (app, i) =>
        `a${i}: refs(refPrefix: "refs/tags/", query: ${JSON.stringify(`${app.name}-prod-v`)}, first: 5, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name } }`,
    )
    .join("\n");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
  const stdout = await run(["gh", "api", "graphql", "-f", `query=${query}`, "--jq", ".data"], {
    cwd,
  });
  const data = JSON.parse(stdout) as {
    repository: Record<string, { nodes: { name: string }[] } | null>;
  };
  const tags = new Map<string, string>();
  apps.forEach((app, i) => {
    const names = data.repository[`a${i}`]?.nodes.map((node) => node.name) ?? [];
    const tag = newestProdTag(app.name, names);
    if (tag) tags.set(app.name, tag);
  });
  return tags;
}

/** Your commits on `branch` since `since`, touching `path` (or anything). */
export async function readCommits(
  run: RunCommand,
  cwd: string,
  options: { repo: string; branch: string; login: string; since: string; path?: string },
): Promise<BranchCommit[]> {
  const query = new URLSearchParams({
    sha: options.branch,
    author: options.login,
    since: options.since,
    per_page: "100",
  });
  if (options.path) query.set("path", options.path);
  const stdout = await run(
    [
      "gh",
      "api",
      "--paginate",
      `repos/${options.repo}/commits?${query}`,
      "--jq",
      // The first three lines hold a merge's PR title; squash bodies can be long.
      '.[] | {sha, date: .commit.committer.date, message: (.commit.message | split("\\n") | .[0:3] | join("\\n"))} | tojson',
    ],
    { cwd },
  );
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BranchCommit);
}

/** The PR merged into `branch` that brought `sha` in, or null. */
export async function readCommitPr(
  run: RunCommand,
  cwd: string,
  options: { repo: string; branch: string; sha: string },
): Promise<PrMerge | null> {
  const stdout = await run(
    [
      "gh",
      "api",
      `repos/${options.repo}/commits/${options.sha}/pulls`,
      "--jq",
      `[.[] | select(.merged_at != null and .base.ref == ${JSON.stringify(options.branch)})] | first | if . then {sha: .merge_commit_sha, number, title, mergedAt: .merged_at} else null end | tojson`,
    ],
    { cwd },
  );
  return JSON.parse(stdout.trim() || "null") as PrMerge | null;
}

/** Is `sha` in production: does the prod tag contain it? */
export async function isLive(
  run: RunCommand,
  cwd: string,
  repo: string,
  tag: string,
  sha: string,
): Promise<boolean> {
  const status = (
    await run(
      ["gh", "api", `repos/${repo}/compare/${tag}...${sha}?per_page=1`, "--jq", ".status"],
      {
        cwd,
      },
    )
  ).trim();
  return status === "behind" || status === "identical";
}

/** Other repos in the org you merged into since `date`; the fixed ones are always checked. */
export async function reposWithMerges(
  run: RunCommand,
  cwd: string,
  options: { org: string; date: string; exclude: string[] },
): Promise<string[]> {
  const argv = [
    "gh",
    "search",
    "prs",
    "--owner",
    options.org,
    "--author",
    "@me",
    "--merged",
    "--merged-at",
    `>=${options.date}`,
    "--limit",
    "300",
    "--json",
    "repository",
  ];
  if (options.exclude.length > 0) argv.push("--", ...options.exclude.map((r) => `-repo:${r}`));
  const rows = JSON.parse(await run(argv, { cwd })) as { repository: { nameWithOwner: string } }[];
  return [...new Set(rows.map((row) => row.repository.nameWithOwner))].sort();
}

// ── Items ────────────────────────────────────────────────────

export interface Undeployed {
  repo: string;
  app: DeployApp;
  tag: string;
  merge: PrMerge;
}

/**
 * One merged PR an app hasn't shipped, in the Ready to promote section. The page groups them by
 * app (`appGroups` in stacks.ts): one promote ships them all.
 */
export function deployToItem({ repo, app, tag, merge }: Undeployed): CollectedItem {
  return {
    key: `deploy:${repo}#${merge.number}:${app.name}`,
    section: "promote",
    title: `#${merge.number} ${merge.title}`,
    url: `https://github.com/${repo}/pull/${merge.number}`,
    waitingOn: null,
    stateLabel: `not in ${app.name} prod`,
    since: merge.mergedAt,
    sourceUpdatedAt: merge.mergedAt,
    meta: {
      repo,
      number: merge.number,
      app: app.name,
      sha: merge.sha,
      mergedAt: merge.mergedAt,
      prodTag: tag,
      workflow: app.workflow,
      promoteUrl: `https://github.com/${repo}/actions/workflows/${app.workflow}`,
    },
  };
}

// ── The collector ────────────────────────────────────────────

export interface DeployOptions {
  cwd: string;
  /** Always checked */
  repos: string[];
  /** Also any repo in this org you merged into within the window */
  org?: string;
  days: number;
  graceHours: number;
  now: Date;
  cache: DeployCache;
}

async function loginFor(run: RunCommand, cwd: string, cache: DeployCache): Promise<string> {
  const known = cache.login.get(cwd);
  if (known) return known;
  const login = (await run(["gh", "api", "user", "--jq", ".login"], { cwd })).trim();
  cache.login.set(cwd, login);
  return login;
}

async function appsFor(
  run: RunCommand,
  cwd: string,
  repo: string,
  options: DeployOptions,
): Promise<RepoApps> {
  const nowMs = options.now.getTime();
  const cached = options.cache.apps.get(repo);
  if (cached && nowMs - cached.at < APPS_TTL_MS) return cached.value;
  const value = await readRepoApps(run, cwd, repo);
  options.cache.apps.set(repo, { at: nowMs, value });
  return value;
}

/** Every app's merges of yours that production doesn't have yet, older than the grace period. */
/**
 * GitHub's own blips: a 5xx, or a busy repo briefly called "Git Repository is empty (HTTP 409)"
 * (seen on the pass right after a restart). One pass makes dozens of calls and runs every 30
 * minutes, so one blip would hide the section that long: each call gets one more try.
 */
const TRANSIENT = /HTTP (409|5\d\d)/;

export function retryTransient(run: RunCommand, delayMs = 2000): RunCommand {
  return async (argv, options) => {
    try {
      return await run(argv, options);
    } catch (error) {
      if (!(error instanceof Error) || !TRANSIENT.test(error.message)) throw error;
      await Bun.sleep(delayMs);
      return run(argv, options);
    }
  };
}

export async function findUndeployed(
  rawRun: RunCommand,
  options: DeployOptions & { retryDelayMs?: number },
): Promise<Undeployed[]> {
  const run = retryTransient(rawRun, options.retryDelayMs);
  const { cwd } = options;
  const since = new Date(options.now.getTime() - options.days * 86_400_000);
  const cutoff = options.now.getTime() - options.graceHours * 3_600_000;
  const login = await loginFor(run, cwd, options.cache);
  const found = options.org
    ? await reposWithMerges(run, cwd, {
        org: options.org,
        date: since.toISOString().slice(0, 10),
        exclude: options.repos,
      })
    : [];
  const repos = [...new Set([...options.repos, ...found])];

  // Repos and apps are walked side by side: one `gh` call takes about half a second.
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const { branch, apps } = await appsFor(run, cwd, repo, options);
      if (apps.length === 0) return [];
      const tags = await readProdTags(run, cwd, repo, apps);
      // Apps share paths (packages/shared-ui/): list each one once per pass.
      const listed = new Map<string, Promise<BranchCommit[]>>();
      const commits = (path?: string) => {
        const key = path ?? "";
        let list = listed.get(key);
        if (!list) {
          list = readCommits(run, cwd, { repo, branch, login, since: since.toISOString(), path });
          listed.set(key, list);
        }
        return list;
      };
      const prOf = (commit: BranchCommit): Promise<PrMerge | null> => {
        const named = prOfCommit(commit.message);
        if (named) return Promise.resolve({ sha: commit.sha, mergedAt: commit.date, ...named });
        const key = `${repo}@${commit.sha}`;
        let pending = options.cache.prs.get(key);
        if (!pending) {
          pending = readCommitPr(run, cwd, { repo, branch, sha: commit.sha });
          options.cache.prs.set(key, pending);
          // A failed lookup is asked again next pass, not remembered.
          pending.catch(() => options.cache.prs.delete(key));
        }
        return pending;
      };
      const perApp = await Promise.all(
        apps.map(async (app) => {
          const tag = tags.get(app.name);
          if (!tag) return [];
          const lists = await Promise.all(
            app.paths.length === 0 ? [commits()] : app.paths.map((path) => commits(path)),
          );
          const unique = [...new Map(lists.flat().map((c) => [c.sha, c])).values()];
          // One entry per PR: a merge's branch commits all lead back to it.
          const byPr = new Map<number, PrMerge>();
          for (const merge of await Promise.all(unique.map(prOf))) {
            if (merge && !byPr.has(merge.number)) byPr.set(merge.number, merge);
          }
          const candidates = [...byPr.values()]
            .filter((merge) => Date.parse(merge.mergedAt) <= cutoff)
            .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
          const behind: Undeployed[] = [];
          for (const merge of candidates) {
            if (await isLive(run, cwd, repo, tag, merge.sha)) break;
            behind.push({ repo, app, tag, merge });
          }
          return behind;
        }),
      );
      return perApp.flat();
    }),
  );
  return perRepo.flat();
}

export async function collectDeploys(
  run: RunCommand,
  options: DeployOptions,
): Promise<CollectedItem[]> {
  return (await findUndeployed(run, options)).map(deployToItem);
}
