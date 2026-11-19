/**
 * Today — config (`extensions.today.config` in ~/.anima/anima.json).
 *
 * One entry per project, each naming the sources it collects from. Every
 * source is optional, so a project with only GitHub, or only a promise
 * ledger, works the same way.
 *
 * Requirements: `gh` (authenticated), `jq` and `bash` for the GitHub sources (the board runs
 * the scripts bundled in `extensions/today/tools`). Linear needs only an API key.
 */

import { z } from "zod";

/**
 * What a session started from the board stops and asks you about before doing it. Every gate
 * defaults to asking: the session prepares the work, puts the question on your board, and
 * waits for your go. Loosen one only on purpose, once you trust how your sessions handle it.
 * See docs/HUMAN-IN-THE-LOOP.md.
 */
const ApprovalsSchema = z
  .object({
    push: z
      .boolean()
      .default(true)
      .describe("Ask before pushing a branch or opening or updating a PR (default true)"),
    merge: z
      .boolean()
      .default(true)
      .describe("Ask before approving or merging a PR (default true)"),
    post: z
      .boolean()
      .default(true)
      .describe(
        "Ask before posting anything other people see: a review, a PR comment or reply, a re-review request, a chat message. With it on, review sessions draft the review for you to post (default true)",
      ),
    deploy: z
      .boolean()
      .default(true)
      .describe("Ask before deploying, promoting, or running a release workflow (default true)"),
  })
  .default({ push: true, merge: true, post: true, deploy: true });

const ProjectSchema = z.object({
  name: z.string().min(1).describe("Project label shown on items (e.g. app)"),
  cwd: z.string().min(1).describe("Project folder: commands run here, and sessions start here"),
  linear: z
    .object({
      promiseLabel: z
        .string()
        .min(1)
        .default("Promise")
        .describe("Issues with this label land in the promise section"),
      apiKey: z
        .string()
        .min(1)
        .optional()
        .describe("This project's Linear API key, when it differs from the top-level one"),
    })
    .optional()
    .describe(
      "Collect your open Linear issues (assigned to the key's user). Off unless an API key is set: here, in the top-level `linear.apiKey`, or in LINEAR_API_KEY",
    ),
  github: z
    .object({
      repos: z
        .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
        .default([])
        .describe("Repos collected on every pass, whatever discovery finds"),
      org: z
        .string()
        .regex(/^[\w.-]+$/)
        .optional()
        .describe(
          "Also collect every repo in this org with an open PR of yours, or one you review (found by search each pass)",
        ),
      reviews: z
        .boolean()
        .default(true)
        .describe("PRs waiting on your review (tools/check-review-queue)"),
      mine: z.boolean().default(true).describe("Your own open PRs (tools/check-my-prs)"),
      deploys: z
        .object({
          days: z
            .number()
            .int()
            .min(1)
            .max(180)
            .default(60)
            .describe("Look at your merges this far back"),
          graceHours: z
            .number()
            .min(0)
            .max(24 * 14)
            .default(24)
            .describe("How long a merge may wait for production before it's listed"),
          intervalMinutes: z
            .number()
            .min(5)
            .max(24 * 60)
            .default(30)
            .describe("Checked at most this often (the Refresh button checks sooner)"),
        })
        .optional()
        .describe(
          "Your merged PRs that production doesn't have yet: the repos plus, with an org, any repo you merged into. Expects `.github/workflows/<app>-deploy-prod.yml` workflows and `<app>-prod-vN` tags (see collectors/deploys.ts)",
        ),
    })
    .refine((github) => github.repos.length > 0 || github.org, {
      message: "github needs repos, an org, or both",
    })
    .optional(),
  worktree: z
    .object({
      branchPrefix: z
        .string()
        .default("")
        .describe("Prefix for the branches it creates, e.g. alex/"),
    })
    .optional()
    .describe(
      "Start each item's session in its own git worktree, so sessions started side by side never share the main checkout",
    ),
  promiseLedger: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Path to a promise ledger JSON file (an example source: see collectors/ledger.ts for its shape). Something else writes it, e.g. a scheduled sweep of your chat threads",
    ),
  reviewChannel: z
    .string()
    .regex(/^[\w-]+$/)
    .optional()
    .describe(
      "Chat channel (no #) where you ask for reviews, e.g. code-review. Only named in the nudge you copy: the board never posts",
    ),
});

export const TodayConfigSchema = z.object({
  /** Background collection; the page also refreshes on focus and every 2 minutes while visible. */
  intervalMinutes: z.number().min(1).max(240).default(5),
  /**
   * GitHub sources (check-review-queue, check-my-prs) collect at most this often, however often
   * the page refreshes: each run spends GraphQL points from the hourly 5,000 that everything
   * running `gh` as you shares. The Refresh button collects them sooner.
   */
  githubIntervalMinutes: z.number().min(1).max(240).default(5),
  /** GitHub collection pauses while fewer GraphQL points than this are left in the hour. */
  githubReserve: z.number().int().min(0).default(1000),
  /** IANA zone for "today" (the top picks' date). Default: this machine's zone. */
  timeZone: z.string().default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  /** Linear, when you use it: one key for every project (a project's own `linear.apiKey` wins). */
  linear: z
    .object({
      apiKey: z.string().min(1).optional().describe("Linear personal API key (or LINEAR_API_KEY)"),
    })
    .default({}),
  approvals: ApprovalsSchema,
  /**
   * The permission profile every session the board starts runs under. "yolo" (bypass
   * permissions) by default, so the approval gates above are prompt text the session follows.
   * Name a stricter profile from agentHost.sessionProfiles to enforce them at the tool level
   * (docs/HUMAN-IN-THE-LOOP.md).
   */
  sessionProfile: z.string().min(1).default("yolo"),
  projects: z.array(ProjectSchema).default([]),
});

export type TodayConfig = z.infer<typeof TodayConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type Approvals = z.infer<typeof ApprovalsSchema>;

export function parseTodayConfig(raw: Record<string, unknown>): TodayConfig {
  return TodayConfigSchema.parse(raw);
}

/** The Linear key a project collects with, or null when Linear is off for it. */
export function linearKey(
  config: Pick<TodayConfig, "linear">,
  project: Pick<ProjectConfig, "linear">,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!project.linear) return null;
  return project.linear.apiKey ?? config.linear.apiKey ?? env.LINEAR_API_KEY ?? null;
}

/** "YYYY-MM-DD" for `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
