import { describe, expect, test } from "bun:test";
import {
  CHECK_MY_PRS,
  CHECK_REVIEW_QUEUE,
  collectMyPrs,
  collectReviews,
  type MyPrRow,
  prState,
  reviewToItem,
} from "./github";
import { ledgerToItems, slackTsToIso } from "./ledger";
import {
  activeProjectIds,
  collectLinear,
  issueToItem,
  LINEAR_API,
  type LinearGraphql,
  type LinearIssue,
  linearClient,
  planPlacer,
} from "./linear";
import type { RunCommand } from "./run";

function pr(overrides: Partial<MyPrRow> = {}): MyPrRow {
  return {
    number: 7,
    title: "Fix the thing",
    url: "https://github.com/acme/app/pull/7",
    isDraft: false,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    headRefName: "fix-the-thing",
    baseRefName: "main",
    defaultBranch: "main",
    conflicts: false,
    reviewDecision: "REVIEW_REQUIRED",
    approved: false,
    designerOnly: false,
    openThreads: 0,
    requested: ["ana", "@core"],
    approvedBy: [],
    changesBy: [],
    reReview: [],
    yourTurn: [],
    notReRequested: [],
    parent: null,
    parentApproved: true,
    waitingOn: null,
    totalChecks: 3,
    failedChecks: 0,
    pendingChecks: 0,
    ...overrides,
  };
}

const approved: Partial<MyPrRow> = {
  reviewDecision: "APPROVED",
  approved: true,
  approvedBy: ["sam"],
  requested: [],
};

describe("prState (one case per row of the state table, first match wins)", () => {
  const cases: [string, Partial<MyPrRow>, string, boolean][] = [
    ["conflicts", { ...approved, conflicts: true, openThreads: 3 }, "conflicts", true],
    ["failing checks", { failedChecks: 2, pendingChecks: 1 }, "2 checks failing", true],
    ["changes requested", { changesBy: ["bob"] }, "changes requested", true],
    ["your turn", { yourTurn: ["sam"], openThreads: 4 }, "your turn: sam", true],
    [
      "open comments, approved",
      { ...approved, openThreads: 4 },
      "approved · 4 open comments",
      true,
    ],
    ["open comments", { openThreads: 1 }, "1 open comment", true],
    [
      "CodeRabbit's threads are ours until resolved",
      { openThreads: 3, botThreads: 1, botThreadAuthors: ["coderabbitai"] },
      "2 open comments · 1 CodeRabbit comment",
      true,
    ],
    [
      "another bot's thread",
      { openThreads: 2, botThreads: 2, botThreadAuthors: ["coderabbitai", "cursor"] },
      "2 bot comments",
      true,
    ],
    [
      "a reviewer's thread we answered last waits on them",
      { waitingThreads: 1, waitingThreadsOn: ["pat"] },
      "waiting on pat's reply",
      false,
    ],
    [
      "approved, waiting on a reply",
      { ...approved, waitingThreads: 2, waitingThreadsOn: ["a", "b"] },
      "approved · waiting on a, b's reply",
      false,
    ],
    ["re-request?", { notReRequested: ["sam"] }, "re-request sam?", true],
    ["ready to merge", approved, "ready to merge", true],
    [
      "ready on an approved parent",
      { ...approved, baseRefName: "b1", parent: 1 },
      "ready to merge",
      true,
    ],
    [
      "approved, parent not approved",
      { ...approved, baseRefName: "b1", parent: 1, parentApproved: false, waitingOn: 1 },
      "approved · waiting on #1",
      false,
    ],
    [
      "approved on a base with no open PR",
      { ...approved, baseRefName: "release", parentApproved: null },
      "approved · base release",
      false,
    ],
    ["approved, CI running", { ...approved, pendingChecks: 2 }, "approved · CI running", false],
    [
      "approved, checks unavailable",
      { ...approved, checksUnavailable: true },
      "approved · checks unavailable",
      false,
    ],
    ["CI running", { pendingChecks: 5 }, "CI running", false],
    [
      "designer-only approval",
      { reviewDecision: "APPROVED", designerOnly: true, approvedBy: ["dana"] },
      "needs an engineer's approval",
      false,
    ],
    [
      "re-review pending",
      { reReview: [{ login: "riley", state: "changes requested" }] },
      "re-review: riley",
      false,
    ],
    ["awaiting review", {}, "awaiting review", false],
    ["draft", { isDraft: true }, "draft", false],
  ];
  for (const [name, overrides, label, actionable] of cases) {
    test(name, () => {
      expect(prState(pr(overrides))).toMatchObject({ label, actionable });
    });
  }

  test("an approved PR with a re-review pending waits on the reviewer, not ready", () => {
    const state = prState(pr({ ...approved, reReview: [{ login: "riley", state: "approved" }] }));
    expect(state).toMatchObject({ kind: "re_review", actionable: false });
  });

  test("changes requested by someone asked to re-review waits on them", () => {
    const state = prState(
      pr({
        changesBy: ["ruby"],
        reReview: [{ login: "ruby", state: "changes requested" }],
      }),
    );
    expect(state).toMatchObject({ label: "re-review: ruby", actionable: false });
  });

  test("drafts surface only what a session can fix", () => {
    expect(prState(pr({ isDraft: true, conflicts: true })).label).toBe("conflicts");
    expect(prState(pr({ isDraft: true, failedChecks: 1 })).label).toBe("1 check failing");
    expect(prState(pr({ isDraft: true, openThreads: 2 })).label).toBe("2 open comments");
    expect(prState(pr({ isDraft: true, yourTurn: ["sam"] }))).toMatchObject({
      label: "draft",
      actionable: false,
    });
  });

  test("awaiting review names who it waits on", () => {
    expect(prState(pr()).waitingOn).toBe("ana, @core");
    expect(prState(pr({ requested: ["a", "b", "c", "d"] })).waitingOn).toBe("a, b +2");
    expect(prState(pr({ requested: [] })).waitingOn).toBeNull();
  });
});

describe("collectMyPrs", () => {
  test("runs check-my-prs in the project folder and keys items by repo", async () => {
    const calls: { argv: string[]; cwd?: string }[] = [];
    const run: RunCommand = async (argv, { cwd }) => {
      calls.push({ argv, cwd });
      return JSON.stringify([pr({ yourTurn: ["sam"] })]);
    };
    const items = await collectMyPrs(run, { cwd: "/work/app", repo: "acme/app" });
    expect(calls).toEqual([
      { argv: [CHECK_MY_PRS, "--json", "--all", "-R", "acme/app"], cwd: "/work/app" },
    ]);
    expect(items[0]).toMatchObject({
      key: "pr:acme/app#7",
      section: "my_pr",
      title: "#7 Fix the thing",
      waitingOn: null,
      stateLabel: "your turn: sam",
      since: "2026-11-01T00:00:00Z",
      meta: { branch: "fix-the-thing", state: "your_turn", actionable: true },
    });
  });
});

describe("reviews", () => {
  test("labels follow-ups and re-requests, and skips team-only requests", async () => {
    const rows = [
      {
        number: 1,
        title: "A",
        url: "u1",
        repo: "acme/app",
        author: "kim",
        section: "requested",
        updatedAt: "2026-11-10T00:00:00Z",
        lastState: null,
        pushedSince: false,
        replies: 0,
      },
      {
        number: 2,
        title: "B",
        url: "u2",
        repo: "acme/app",
        author: "kim",
        section: "followup",
        updatedAt: "2026-11-10T00:00:00Z",
        lastState: "COMMENTED",
        pushedSince: false,
        replies: 2,
      },
      {
        number: 3,
        title: "C",
        url: "u3",
        repo: "acme/app",
        author: "kim",
        section: "team",
        updatedAt: "2026-11-10T00:00:00Z",
        lastState: null,
        pushedSince: false,
        replies: 0,
      },
    ];
    const run: RunCommand = async (argv) => {
      expect(argv).toEqual([CHECK_REVIEW_QUEUE, "--json", "-R", "acme/app"]);
      return JSON.stringify(rows);
    };
    const items = await collectReviews(run, { cwd: "/work/app", repo: "acme/app" });
    expect(items.map((i) => [i.key, i.stateLabel])).toEqual([
      ["review:acme/app#1", "review requested"],
      ["review:acme/app#2", "2 replies to you"],
    ]);
    expect(
      reviewToItem({ ...rows[0]!, section: "requested", lastState: "APPROVED" }).stateLabel,
    ).toBe("re-requested");
  });
});

describe("linear", () => {
  const issue = (id: string, labels: string[] = []): LinearIssue => ({
    identifier: id,
    title: "Do it",
    url: `https://linear.app/x/issue/${id}`,
    dueDate: null,
    updatedAt: "2026-11-10T00:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
    priority: 2,
    priorityLabel: "High",
    state: { name: "In Progress", type: "started" },
    labels: { nodes: labels.map((name) => ({ name })) },
    project: null,
    cycle: null,
  });

  test("promise-labelled issues land in the promise section", () => {
    expect(issueToItem(issue("X-1", ["Promise"]), "Promise").section).toBe("promise");
    expect(issueToItem(issue("X-2"), "Promise").section).toBe("ticket");
  });

  test("pages through every assigned issue", async () => {
    const pages = [
      {
        viewer: {
          assignedIssues: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [issue("X-1")],
          },
        },
      },
      {
        viewer: {
          assignedIssues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [issue("X-2")],
          },
        },
      },
    ];
    const afters: (string | null)[] = [];
    const linear = (async (_query: string, variables?: Record<string, unknown>) => {
      afters.push((variables as { after: string | null }).after);
      return pages[afters.length - 1];
    }) as LinearGraphql;
    const items = await collectLinear(linear, { promiseLabel: "Promise" });
    expect(afters).toEqual([null, "c1"]);
    expect(items.map((i) => i.key)).toEqual(["linear:X-1", "linear:X-2"]);
  });

  test("the client posts to Linear's GraphQL API with the key as it is, and unwraps data", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }));
    }) as unknown as typeof fetch;
    const data = await linearClient(
      "lin_api_test",
      fake,
    )<{ viewer: { id: string } }>("query { viewer { id } }");
    expect(data.viewer.id).toBe("u1");
    expect(seen[0]!.url).toBe(LINEAR_API);
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("lin_api_test");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      query: "query { viewer { id } }",
      variables: {},
    });
  });

  test("the client throws on a GraphQL error instead of returning nothing", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(linearClient("bad", fake)("query { viewer { id } }")).rejects.toThrow(
      "Authentication required",
    );
  });

  test("favorited projects that are still going are active; finished ones aren't", () => {
    const fav = (id: string, state: string) => ({ type: "project", project: { id, state } });
    const active = activeProjectIds({
      nodes: [
        fav("checkout", "backlog"),
        fav("old", "completed"),
        fav("dropped", "canceled"),
        { type: "customView", project: null },
      ],
    });
    expect([...active]).toEqual(["checkout"]);
  });

  test("the current phase is the earliest milestone still holding one of your issues", () => {
    const at = (id: string, project: string | null, order: number | null): LinearIssue => ({
      ...issue(id),
      project: project ? { id: project, name: project } : null,
      projectMilestone: order === null ? null : { name: `${order}: Phase`, sortOrder: order },
    });
    const issues = [
      at("A-1", "checkout", 2),
      at("A-2", "checkout", 1),
      at("A-3", "checkout", null),
      at("B-1", "other", 1),
      at("C-1", null, null),
    ];
    const place = planPlacer(issues, new Set(["checkout"]));
    expect(issues.map((i) => place(i))).toEqual([
      { activeProject: true, currentPhase: false },
      { activeProject: true, currentPhase: true },
      { activeProject: true, currentPhase: false },
      { activeProject: false, currentPhase: false },
      { activeProject: false, currentPhase: false },
    ]);
    expect(issueToItem(issues[1]!, "Slack promise", place(issues[1]!)).meta).toMatchObject({
      milestone: "1: Phase",
      milestoneOrder: 1,
      activeProject: true,
      currentPhase: true,
    });
  });
});

describe("ledger", () => {
  test("open threads become promises; decided ones are skipped", () => {
    const items = ledgerToItems({
      threads: {
        "C01:1700000000.000100": {
          status: "open",
          title: "Send Riley the export",
          asker: "Riley",
          where: "#proj-x",
          permalink: "https://slack/p1",
          last_seen_ts: "1700086400.000200",
        },
        "C01:1699990000.000001": { status: "done" },
        "D02:1699990000.000002": { status: "open", note: "reply with the link" },
      },
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      key: "slack:C01:1700000000.000100",
      section: "promise",
      title: "Send Riley the export",
      waitingOn: "Riley",
      stateLabel: "#proj-x",
      since: slackTsToIso("1700000000.000100"),
    });
    expect(items[1]?.title).toBe("reply with the link");
  });
});
