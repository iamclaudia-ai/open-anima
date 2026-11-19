import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { reviewToItem } from "./collectors/github";
import { createTodayExtension } from "./index";
import { launchBranch, launchPrompt, launchTitle, planStackLaunch } from "./launch";
import {
  addItem,
  applyCollection,
  getItem,
  linkStackSessions,
  setSession,
  type TodayItem,
} from "./store";
import { todayTestDb } from "./test-db";

const T0 = "2026-11-12T09:00:00.000Z";

function collectedReview(db: ReturnType<typeof todayTestDb>): TodayItem {
  applyCollection(
    db,
    "shop:reviews:acme/shop",
    "shop",
    [
      {
        key: "review:acme/shop#131",
        section: "review",
        title: "#131 Fix the login redirect for guests",
        url: "https://github.com/acme/shop/pull/131",
        waitingOn: "Casey",
      },
    ],
    T0,
  );
  return getItem(db, "review:acme/shop#131")!;
}

describe("launchPrompt", () => {
  test("carries the item, the ask for its section, and how it closes", () => {
    const prompt = launchPrompt(collectedReview(todayTestDb()));
    expect(prompt).toContain("From my Today board: #131 Fix the login redirect");
    expect(prompt).toContain("https://github.com/acme/shop/pull/131");
    expect(prompt).toContain("Waiting: Casey");
    expect(prompt).toContain("Please review this PR in full and draft the review");
    expect(prompt).toContain("Don't post it");
    expect(prompt).not.toContain("post your verdict");
    // A collected item closes itself; the session only closes it when it ends some other way.
    expect(prompt).toContain("The board closes this item by itself");
    expect(prompt).toContain("anima today complete --key 'review:acme/shop#131'");
  });

  test("a hand-added item is closed by the session, since no collector ever will", () => {
    const db = todayTestDb();
    const task = addItem(db, { key: "manual:abc", project: "shop", title: "Rotate the key" }, T0);
    const prompt = launchPrompt(task);
    expect(prompt).toContain("This is something I promised someone.");
    expect(prompt).not.toContain("closes this item by itself");
    expect(prompt).toContain("When it's done, close it on the board");
  });

  test("the session name leads with what to do", () => {
    expect(launchTitle({ section: "ticket", title: "ENG-105 Add CSV export" })).toBe(
      "Work: ENG-105 Add CSV export",
    );
  });

  test("your note from the Start dialog comes after the facts, ahead of the standing steps", () => {
    const prompt = launchPrompt(
      collectedReview(todayTestDb()),
      undefined,
      "  Casey already merged a fix for this; just approve.  ",
    );
    const note = prompt.indexOf("My note before you start");
    expect(note).toBeGreaterThan(prompt.indexOf("Waiting: Casey"));
    expect(note).toBeLessThan(prompt.indexOf("Please review this PR in full"));
    expect(prompt).toContain("say):\nCasey already merged a fix for this; just approve.\n");
  });

  test("a blank note adds nothing", () => {
    const item = collectedReview(todayTestDb());
    expect(launchPrompt(item, undefined, "  \n ")).toBe(launchPrompt(item));
  });

  test("in a worktree, a review checks the PR out there instead of making another", () => {
    const prompt = launchPrompt(collectedReview(todayTestDb()), "alex/review-131");
    expect(prompt).toContain("You're in your own worktree (branch `alex/review-131`)");
    expect(prompt).toContain("gh pr checkout 131 --detach");
  });
});

describe("launchBranch", () => {
  const item = (section: TodayItem["section"], title: string, meta: TodayItem["meta"] = null) => ({
    section,
    title,
    key: "k",
    meta,
  });

  test("each kind of item gets its own branch under the prefix", () => {
    expect(
      launchBranch(item("ticket", "ENG-105 Add CSV export to the reports page"), "alex/"),
    ).toBe("alex/add-csv-export-to-the-reports-page-ENG-105");
    expect(launchBranch(item("review", "#131 Fix the login redirect"), "alex/")).toBe(
      "alex/review-131",
    );
    expect(launchBranch(item("promise", "Send Casey the API notes!"), "alex/")).toBe(
      "alex/promise-send-casey-the-api-notes",
    );
    expect(launchBranch(item("promise", "Rotate the key"), "")).toBe("promise-rotate-the-key");
  });

  test("our own PR reuses its branch, so pushes land on the PR", () => {
    const pr = item("my_pr", "#132 Rename the settings tab", {
      branch: "alex/rename-settings-ENG-1",
    });
    expect(launchBranch(pr, "alex/")).toBe("alex/rename-settings-ENG-1");
    expect(() => launchBranch(item("my_pr", "#1 Old row"), "alex/")).toThrow("no branch yet");
  });

  test("our own PR's session resolves every CodeRabbit thread, and leaves a reviewer's reply to them", () => {
    const prompt = launchPrompt({
      ...item("my_pr", "#1 A PR", { branch: "b" }),
      id: 1,
    } as unknown as TodayItem);
    expect(prompt).toContain("Treat AI reviewers' threads (CodeRabbit and the like) as ours");
    expect(prompt).toContain("waits on them");
  });

  test("long titles are cut at a word boundary", () => {
    const branch = launchBranch(
      item("promise", "Move the old billing settings into the new account settings page"),
      "",
    );
    expect(branch).toBe("promise-move-the-old-billing-settings-into-the");
  });
});

function harness(projectConfig: Record<string, unknown> = {}) {
  const db = todayTestDb();
  const spawns: Array<Record<string, unknown>> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  /** Holds every prompt, as the session extension does while a worktree is being made. */
  let promptGate: Promise<void> | null = null;
  const errors: string[] = [];
  const titles: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const ctx = {
    log: { info() {}, warn() {}, error: (message: string) => errors.push(message), debug() {} },
    emit: (type: string) => events.push(type),
    on: (pattern: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(pattern, handler);
      return () => handlers.delete(pattern);
    },
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === "session.send_prompt") {
        prompts.push(params);
        if (promptGate) await promptGate;
        return { ok: true };
      }
      if (method === "session.set_title") {
        titles.push(params);
        return { ok: true };
      }
      expect(method).toBe("session.create_session");
      spawns.push(params);
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return { sessionId: `sess-${spawns.length}`, workspaceId: "ws-shop" };
    },
  } as unknown as ExtensionContext;
  const extension = createTodayExtension(
    { projects: [{ name: "shop", cwd: "/repo/shop", ...projectConfig }] },
    { openDb: () => db },
  );
  return {
    db,
    spawns,
    prompts,
    events,
    errors,
    titles,
    /** Deliver a gateway event to whatever the extension subscribed for `pattern`. */
    fire: (pattern: string, payload: unknown) => handlers.get(pattern)?.({ payload }),
    gatePrompts: (gate: Promise<void>) => (promptGate = gate),
    extension,
    start: () => extension.start(ctx),
    holdSpawns: () => (hold = true),
    releaseSpawn: () => release?.(),
  };
}

describe("today.launch", () => {
  test("starts a session in the item's project, remembers it, then prompts it", async () => {
    const h = harness();
    await h.start();
    const item = collectedReview(h.db);

    const result = (await h.extension.handleMethod("today.launch", { id: item.id })) as {
      item: TodayItem;
      started: boolean;
    };

    expect(result.started).toBe(true);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]).toEqual({
      cwd: "/repo/shop",
      title: "Review: #131 Fix the login redirect for guests",
      profile: "yolo",
      origin: "user",
    });
    expect(result.item.sessionId).toBe("sess-1");
    expect(result.item.sessionWorkspaceId).toBe("ws-shop");
    expect(h.events).toContain("today.changed");
    expect(h.prompts[0]?.content).toContain(
      "anima today ask --key 'review:acme/shop#131' --question",
    );
    expect(h.prompts).toEqual([
      {
        sessionId: "sess-1",
        content: expect.stringContaining("Please review this PR"),
        streaming: true,
      },
    ]);
    await h.extension.stop();
  });

  test("your note goes into the new session's first prompt", async () => {
    const h = harness();
    await h.start();
    const item = collectedReview(h.db);

    await h.extension.handleMethod("today.launch", {
      id: item.id,
      context: "I did this on Friday. Close it as kept.",
    });

    expect(String(h.prompts[0]?.content)).toContain(
      "My note before you start (it comes first, even where it changes what the steps below say):\nI did this on Friday. Close it as kept.",
    );
    await h.extension.stop();
  });

  test("a project with worktrees starts each session in its own, with the prompt saying so", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    const item = collectedReview(h.db);

    await h.extension.handleMethod("today.launch", { id: item.id });

    expect(h.spawns[0]).toMatchObject({ cwd: "/repo/shop", worktree: "alex/review-131" });
    expect(h.prompts[0]?.content).toContain("You're in your own worktree");
    await h.extension.stop();
  });

  test("links the session without waiting for its prompt (a worktree takes minutes)", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    let fail!: (error: Error) => void;
    h.gatePrompts(new Promise<void>((_, reject) => (fail = reject)));

    const result = (await h.extension.handleMethod("today.launch", {
      id: collectedReview(h.db).id,
    })) as { item: TodayItem };
    expect(result.item.sessionId).toBe("sess-1");
    expect(h.prompts).toHaveLength(1);

    // A prompt that fails later is logged, never thrown at the page.
    fail(new Error("The worktree for alex/review-131 couldn't be set up"));
    await Bun.sleep(0);
    expect(h.errors).toEqual([expect.stringContaining("didn't get its prompt")]);
    await h.extension.stop();
  });

  test("without worktree config the session starts in the main checkout", async () => {
    const h = harness();
    await h.start();
    await h.extension.handleMethod("today.launch", { id: collectedReview(h.db).id });
    expect(h.spawns[0]).not.toHaveProperty("worktree");
    await h.extension.stop();
  });

  test("a second press returns the existing session; restart starts a fresh one", async () => {
    const h = harness();
    await h.start();
    const item = collectedReview(h.db);
    await h.extension.handleMethod("today.launch", { id: item.id });

    const again = (await h.extension.handleMethod("today.launch", { id: item.id })) as {
      item: TodayItem;
      started: boolean;
    };
    expect(again).toMatchObject({ started: false, item: { sessionId: "sess-1" } });
    expect(h.spawns).toHaveLength(1);

    const fresh = (await h.extension.handleMethod("today.launch", {
      id: item.id,
      restart: true,
    })) as { item: TodayItem };
    expect(fresh.item.sessionId).toBe("sess-2");
    await h.extension.stop();
  });

  test("a double tap while the first session is still starting doesn't start two", async () => {
    const h = harness();
    await h.start();
    const item = collectedReview(h.db);
    h.holdSpawns();

    const first = h.extension.handleMethod("today.launch", { id: item.id });
    await expect(h.extension.handleMethod("today.launch", { id: item.id })).rejects.toThrow(
      "Already starting",
    );
    h.releaseSpawn();
    await first;
    expect(h.spawns).toHaveLength(1);
    await h.extension.stop();
  });

  test("a handoff takes the item's session with it", async () => {
    const h = harness();
    await h.start();
    const item = collectedReview(h.db);
    await h.extension.handleMethod("today.launch", { id: item.id });

    h.fire("session.*.handoff", {
      sessionId: "sess-1",
      targetSessionId: "sess-next",
      workspaceId: "ws-shop",
    });
    expect(getItem(h.db, item.id)?.sessionId).toBe("sess-next");
    await h.extension.stop();
  });

  test("an item from a project Today doesn't know is refused, not started somewhere else", async () => {
    const h = harness();
    await h.start();
    const task = addItem(h.db, { project: "notes", title: "Ship it" }, T0);
    await expect(h.extension.handleMethod("today.launch", { id: task.id })).rejects.toThrow(
      "No Today project named notes",
    );
    expect(h.spawns).toHaveLength(0);
    await h.extension.stop();
  });
});

/** Our PRs: #10 on main, #11 on #10, #12 on #11, and #20 on its own. */
function collectStack(db: ReturnType<typeof todayTestDb>, extra: number[] = []): TodayItem[] {
  const pr = (number: number, parent: number | null) => ({
    key: `pr:acme/shop#${number}`,
    section: "my_pr" as const,
    title: `#${number} Part ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    stateLabel: "conflicts",
    meta: {
      repo: "acme/shop",
      number,
      parent,
      branch: `alex/part-${number}`,
      actionable: true,
    },
  });
  applyCollection(
    db,
    "shop:mine:acme/shop",
    "shop",
    [pr(12, 11), pr(10, null), pr(11, 10), pr(20, null), ...extra.map((n) => pr(n, n - 1))],
    T0,
  );
  return [10, 11, 12].map((n) => getItem(db, `pr:acme/shop#${n}`)!);
}

describe("today.launch on a stacked PR", () => {
  test("starts one session for the whole stack, in the bottom PR's worktree", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    const [bottom, middle, top] = collectStack(h.db);

    const result = (await h.extension.handleMethod("today.launch", { id: middle!.id })) as {
      started: boolean;
      stack: number;
    };

    expect(result).toMatchObject({ started: true, stack: 3 });
    expect(h.spawns).toEqual([
      {
        cwd: "/repo/shop",
        worktree: "alex/part-10",
        title: "Land stack: #10 Part 10 (+2)",
        profile: "yolo",
        origin: "user",
      },
    ]);
    for (const member of [bottom, middle, top]) {
      expect(getItem(h.db, member!.id)).toMatchObject({ sessionId: "sess-1", sessionStack: true });
    }
    expect(getItem(h.db, "pr:acme/shop#20")?.sessionId).toBeNull();
    const content = String(h.prompts[0]?.content);
    expect(content).toContain("a stack of 3 of our PRs, bottom first");
    expect(content.indexOf("#10 Part 10")).toBeLessThan(content.indexOf("#12 Part 12"));
    expect(content).toContain("board key `pr:acme/shop#11`");
    expect(content).toContain("branch `alex/part-10`");
    expect(content).toContain("--key '<the key of the PR it's about>'");
    expect(content).toContain("reply with why not and resolve the thread");
    expect(content).toContain("Stop and ask me before you do any of these");

    // Any PR in it now opens that session.
    const again = (await h.extension.handleMethod("today.launch", { id: top!.id })) as {
      started: boolean;
    };
    expect(again.started).toBe(false);
    expect(h.spawns).toHaveLength(1);
    await h.extension.stop();
  });

  test("your note reaches the stack's session, after the list", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    const [bottom] = collectStack(h.db);

    await h.extension.handleMethod("today.launch", {
      id: bottom!.id,
      context: "Part 11 can wait for Monday.",
    });

    const content = String(h.prompts[0]?.content);
    const note = content.indexOf("Part 11 can wait for Monday.");
    expect(note).toBeGreaterThan(content.indexOf("#12 Part 12"));
    expect(note).toBeLessThan(content.indexOf("Work it as one stack"));
    await h.extension.stop();
  });

  test("a session already on one of its PRs takes the whole stack", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    const [bottom, middle] = collectStack(h.db);
    setSession(h.db, middle!.id, { sessionId: "sess-old", workspaceId: "ws-shop" }, T0);

    const result = (await h.extension.handleMethod("today.launch", { id: bottom!.id })) as {
      started: boolean;
    };

    expect(result.started).toBe(false);
    expect(h.spawns).toHaveLength(0);
    expect(getItem(h.db, bottom!.id)).toMatchObject({ sessionId: "sess-old", sessionStack: true });
    expect(h.titles).toEqual([{ sessionId: "sess-old", title: "Land stack: #10 Part 10 (+2)" }]);
    expect(h.prompts).toEqual([
      {
        sessionId: "sess-old",
        content: expect.stringContaining("the whole stack is yours now"),
        streaming: true,
      },
    ]);
    await h.extension.stop();
  });

  test("a PR stacked on it later joins the stack's session", async () => {
    const h = harness();
    await h.start();
    const [bottom] = collectStack(h.db);
    await h.extension.handleMethod("today.launch", { id: bottom!.id });

    collectStack(h.db, [13]);
    expect(linkStackSessions(h.db, T0)).toBe(1);
    expect(getItem(h.db, "pr:acme/shop#13")).toMatchObject({
      sessionId: "sess-1",
      sessionStack: true,
    });
    await h.extension.stop();
  });

  test("a session started for one PR doesn't spread to the rest by itself", () => {
    const db = todayTestDb();
    const [, middle] = collectStack(db);
    setSession(db, middle!.id, { sessionId: "sess-old", workspaceId: "ws-shop" }, T0);
    expect(linkStackSessions(db, T0)).toBe(0);
  });
});

/** Casey's stack #80 → #81 → #82 → #83; #81 already left the queue (approved). */
function collectReviewStack(db: ReturnType<typeof todayTestDb>, queued = [80, 82, 83]) {
  const stack = [80, 81, 82, 83].map((number) => ({
    number,
    title: `Part ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    inQueue: queued.includes(number),
  }));
  applyCollection(
    db,
    "shop:reviews:acme/shop",
    "shop",
    queued.map((number) =>
      reviewToItem({
        number,
        title: `Part ${number}`,
        url: `https://github.com/acme/shop/pull/${number}`,
        repo: "acme/shop",
        author: "Casey",
        section: "requested",
        updatedAt: T0,
        lastState: null,
        pushedSince: false,
        replies: 0,
        parent: number === 80 ? null : number - 1,
        stack,
      }),
    ),
    T0,
  );
  return queued.map((n) => getItem(db, `review:acme/shop#${n}`)!);
}

describe("today.launch on a review stack", () => {
  test("one session checks out the whole stack and reviews the queued PRs bottom up", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    const [bottom, middle, top] = collectReviewStack(h.db);

    await h.extension.handleMethod("today.launch", { id: top!.id });

    expect(h.spawns).toEqual([
      {
        cwd: "/repo/shop",
        worktree: "alex/review-stack-80",
        title: "Review stack: #80 Part 80 (+3)",
        profile: "yolo",
        origin: "user",
      },
    ]);
    for (const member of [bottom, middle, top]) {
      expect(getItem(h.db, member!.id)).toMatchObject({ sessionId: "sess-1", sessionStack: true });
    }
    const content = String(h.prompts[0]?.content);
    expect(content).toContain(
      "a stack of 4 PRs by Casey, bottom first, with 3 waiting on my review",
    );
    expect(content).toContain("2. #81 Part 81: context only");
    expect(content).toContain("3. #82 Part 82 (review requested): review this one");
    expect(content).toContain("board key `review:acme/shop#83`");
    expect(content).toContain("gh pr checkout 83 --detach");
    await h.extension.stop();
  });

  test("a lone queued PR of a stack still gets the stack's session, with the rest as context", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    const [only] = collectReviewStack(h.db, [82]);

    await h.extension.handleMethod("today.launch", { id: only!.id });

    expect(h.spawns[0]).toMatchObject({ worktree: "alex/review-stack-80" });
    expect(getItem(h.db, only!.id)).toMatchObject({ sessionId: "sess-1", sessionStack: true });
    expect(String(h.prompts[0]?.content)).toContain("with one waiting on my review");

    // Casey asks again on #83 later: it joins the same session.
    collectReviewStack(h.db, [82, 83]);
    expect(linkStackSessions(h.db, T0)).toBe(1);
    expect(getItem(h.db, "review:acme/shop#83")?.sessionId).toBe("sess-1");
    await h.extension.stop();
  });
});

describe("planStackLaunch", () => {
  const member = (sessionId: string | null, sessionStack = false) => ({
    key: "k",
    title: "#1 t",
    url: null,
    stateLabel: null,
    topReason: null,
    note: null,
    sessionId,
    sessionWorkspaceId: sessionId && "ws",
    sessionStack,
  });

  test("prefers the session that already works the stack, and names the others", () => {
    const plan = planStackLaunch(
      [member("solo"), member("stack", true), member(null), member("stack", true)],
      false,
    );
    expect(plan).toEqual({
      kind: "adopt",
      session: { sessionId: "stack", workspaceId: "ws" },
      others: ["solo"],
    });
  });

  test("restart always starts fresh", () => {
    expect(planStackLaunch([member("a", true), member("a", true)], true)).toEqual({
      kind: "new",
      others: ["a"],
    });
  });
});

/** Three reviews waiting on you; #3 already has a session of its own. */
function collectReviews(db: ReturnType<typeof todayTestDb>): TodayItem[] {
  applyCollection(
    db,
    "shop:reviews:acme/shop",
    "shop",
    [1, 2, 3].map((n) => ({
      key: `review:acme/shop#${n}`,
      section: "review" as const,
      title: `#${n} Change ${n}`,
      url: `https://github.com/acme/shop/pull/${n}`,
    })),
    T0,
  );
  const items = [1, 2, 3].map((n) => getItem(db, `review:acme/shop#${n}`)!);
  setSession(db, items[2]!.id, { sessionId: "sess-own", workspaceId: "ws-shop" }, T0);
  return items;
}

describe("today.review_queue", () => {
  test("starts one session in the main checkout that runs the review queue skill", async () => {
    const h = harness({ worktree: { branchPrefix: "alex/" } });
    await h.start();
    collectReviews(h.db);

    const result = (await h.extension.handleMethod("today.review_queue", {
      context: "Skip the copy nits.",
    })) as { started: Array<Record<string, unknown>> };

    expect(result.started).toEqual([
      { project: "shop", sessionId: "sess-1", workspaceId: "ws-shop", queued: 2 },
    ]);
    // No worktree: each review in the chain makes its own.
    expect(h.spawns).toEqual([
      { cwd: "/repo/shop", title: "Review queue · shop", profile: "yolo", origin: "user" },
    ]);
    const content = String(h.prompts[0]?.content);
    expect(content).toContain("If the running-review-sessions skill is installed");
    expect(content).toContain("check-review-queue --json -R acme/shop");
    // Drafts only: the user posts.
    expect(content).toContain("post none of them");
    expect(content).not.toContain("posting each verdict yourself");
    expect(content).toContain("#1 Change 1 (board key `review:acme/shop#1`)");
    expect(content).toContain("#2 Change 2");
    expect(content).toContain("Skip the copy nits.");
    expect(content).toContain(
      "These already have their own session, so leave them out of the queue:\n- #3 Change 3",
    );
    expect(h.events).toContain("today.changed");
    await h.extension.stop();
  });

  test("links the queued reviews to it, and the links follow the chain's handoffs", async () => {
    const h = harness();
    await h.start();
    const [first, second, own] = collectReviews(h.db);

    await h.extension.handleMethod("today.review_queue", {});
    expect(getItem(h.db, first!.id)?.sessionId).toBe("sess-1");
    expect(getItem(h.db, second!.id)?.sessionId).toBe("sess-1");
    expect(getItem(h.db, own!.id)?.sessionId).toBe("sess-own");

    h.fire("session.*.handoff", {
      sessionId: "sess-1",
      targetSessionId: "sess-next",
      workspaceId: "ws-shop",
    });
    expect(getItem(h.db, second!.id)?.sessionId).toBe("sess-next");
    await h.extension.stop();
  });

  test("refuses when every review already has a session", async () => {
    const h = harness();
    await h.start();
    collectReviews(h.db);
    await h.extension.handleMethod("today.review_queue", {});

    await expect(h.extension.handleMethod("today.review_queue", {})).rejects.toThrow(
      "No reviews waiting without a session",
    );
    expect(h.spawns).toHaveLength(1);
    await h.extension.stop();
  });

  test("a double tap starts one queue", async () => {
    const h = harness();
    await h.start();
    collectReviews(h.db);
    h.holdSpawns();

    const first = h.extension.handleMethod("today.review_queue", {});
    await expect(h.extension.handleMethod("today.review_queue", {})).rejects.toThrow(
      "Already starting a session for one of these reviews",
    );
    h.releaseSpawn();
    await first;
    expect(h.spawns).toHaveLength(1);
    await h.extension.stop();
  });
});
