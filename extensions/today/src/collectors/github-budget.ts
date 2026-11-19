/**
 * GitHub's GraphQL budget: 5,000 points an hour, shared by everything that runs `gh` as
 * you (your terminal, every session, this board). The review-queue scripts spend it, so the
 * board checks what's left before collecting and stands aside when it runs low.
 *
 * `gh api rate_limit` itself costs nothing.
 */

import type { RunCommand } from "./run";

export interface GithubBudget {
  remaining: number;
  limit: number;
  /** When the hour's budget refills. */
  resetAt: string;
}

export async function readGithubBudget(run: RunCommand, cwd: string): Promise<GithubBudget> {
  const stdout = await run(["gh", "api", "rate_limit", "--jq", ".resources.graphql"], {
    cwd,
    timeoutMs: 15_000,
  });
  const graphql = JSON.parse(stdout) as { limit: number; remaining: number; reset: number };
  return {
    remaining: graphql.remaining,
    limit: graphql.limit,
    resetAt: new Date(graphql.reset * 1000).toISOString(),
  };
}

/** A collector failed because the budget ran out (the bundled scripts pass gh's message on). */
export function isRateLimited(message: string): boolean {
  return /rate limit/i.test(message);
}
