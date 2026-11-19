/**
 * Which repos in an org have something open for you right now, so the GitHub collectors
 * (check-my-prs, check-review-queue) run only where there's something to find, and a repo
 * joins or leaves the board by itself as PRs open and merge. No repo list to keep up to date.
 *
 * Uses GitHub's search API, whose rate limit (30/min) is separate from the GraphQL budget the
 * collectors spend. Always scoped to one org (`--owner`): searching your whole account would
 * pull in personal and private projects. Runs in the project folder, so a `gh` that picks its
 * account by folder picks the one that can see the org.
 */

import type { RunCommand } from "./run";

export interface DiscoveredRepos {
  /** Repos with an open PR of yours (for check-my-prs). */
  mine: string[];
  /** Repos with an open PR you were asked to review or already reviewed (for check-review-queue). */
  reviews: string[];
}

/** More than any real count; `gh search` returns only 30 without it. */
const LIMIT = "300";

async function reposMatching(
  run: RunCommand,
  cwd: string,
  org: string,
  filter: string[],
): Promise<string[]> {
  const stdout = await run(
    [
      "gh",
      "search",
      "prs",
      "--owner",
      org,
      "--state",
      "open",
      ...filter,
      "--limit",
      LIMIT,
      "--json",
      "repository",
    ],
    { cwd },
  );
  const rows = JSON.parse(stdout) as { repository: { nameWithOwner: string } }[];
  return rows.map((row) => row.repository.nameWithOwner);
}

/** Throws when any search fails: a partial answer must never close a repo's items. */
export async function discoverRepos(
  run: RunCommand,
  options: { cwd: string; org: string },
): Promise<DiscoveredRepos> {
  const { cwd, org } = options;
  const [mine, requested, reviewed] = await Promise.all([
    reposMatching(run, cwd, org, ["--author", "@me"]),
    reposMatching(run, cwd, org, ["--review-requested", "@me"]),
    reposMatching(run, cwd, org, ["--reviewed-by", "@me"]),
  ]);
  const sorted = (repos: string[]) => [...new Set(repos)].sort();
  return { mine: sorted(mine), reviews: sorted([...requested, ...reviewed]) };
}
