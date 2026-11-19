import { describe, expect, test } from "bun:test";
import { createAsking, isAnswer, isPromptWaiting } from "./questions";
import { addItem, getItem, setSession, type TodayItem } from "./store";
import { todayTestDb } from "./test-db";

const T0 = new Date("2026-11-13T15:00:00.000Z");

function harness() {
  const db = todayTestDb();
  let clock = T0;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const changes: string[] = [];
  const asking = createAsking({
    db: () => db,
    call: async (method, params) => {
      calls.push([method, params]);
      return {};
    },
    emit: (event, payload) => events.push([event, payload]),
    changed: (reason) => changes.push(reason),
    warn: () => {},
    now: () => clock,
  });
  const item = (): TodayItem => {
    const task = addItem(
      db,
      { key: "manual:t", project: "shop", title: "Ship it" },
      T0.toISOString(),
    );
    return setSession(db, task.id, { sessionId: "sess-1", workspaceId: "ws-1" }, T0.toISOString());
  };
  return {
    db,
    calls,
    events,
    changes,
    asking,
    item,
    advance: (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000)),
  };
}

describe("today.ask", () => {
  test("puts the question on the item, blocks the session and pops a notification", async () => {
    const h = harness();
    const asked = await h.asking.ask(h.item(), "Keep the old URL, or redirect it?");

    expect(asked).toMatchObject({
      question: "Keep the old URL, or redirect it?",
      askedAt: T0.toISOString(),
    });
    expect(h.calls).toEqual([
      ["session.set_status", { sessionId: "sess-1", disposition: "blocked" }],
    ]);
    expect(h.events).toEqual([
      [
        "today.needs_you",
        {
          itemId: asked.id,
          title: "Needs your answer · Ship it",
          message: "Keep the old URL, or redirect it?",
          url: "/chat/ws-1/sess-1",
        },
      ],
    ]);
    expect(h.changes).toEqual(["today.ask"]);
  });

  test("your next message clears it and reopens the session", async () => {
    const h = harness();
    const { id } = await h.asking.ask(h.item(), "Which one?");
    h.calls.length = 0;

    // The session's own turn ending, then the blocked status it set: neither is an answer.
    await h.asking.onStatus({
      sessionId: "sess-1",
      runtimeStatus: "idle",
      previousRuntimeStatus: "running",
    });
    await h.asking.onStatus({ sessionId: "sess-1", runtimeStatus: "idle" });
    expect(getItem(h.db, id)?.question).toBe("Which one?");

    await h.asking.onStatus({
      sessionId: "sess-1",
      runtimeStatus: "running",
      previousRuntimeStatus: "stalled",
    });
    expect(getItem(h.db, id)).toMatchObject({ question: null, askedAt: null });
    expect(h.calls).toEqual([["session.set_status", { sessionId: "sess-1", disposition: "open" }]]);
    expect(h.changes).toContain("today.answered");
  });

  test("a prompt in the pane notifies, and answering it isn't answering the question", async () => {
    const h = harness();
    const { id } = await h.asking.ask(h.item(), "Which one?");
    h.events.length = 0;

    await h.asking.onStatus({
      sessionId: "sess-1",
      runtimeStatus: "awaiting_approval",
      previousRuntimeStatus: "running",
    });
    expect(h.events).toEqual([
      [
        "today.needs_you",
        expect.objectContaining({
          message: "I'm waiting on your approval.",
          url: "/chat/ws-1/sess-1",
        }),
      ],
    ]);
    await h.asking.onStatus({
      sessionId: "sess-1",
      runtimeStatus: "running",
      previousRuntimeStatus: "awaiting_approval",
    });
    expect(getItem(h.db, id)?.question).toBe("Which one?");
  });

  test("a stack's session waiting on a prompt pops one toast, not one per PR", async () => {
    const h = harness();
    h.item();
    const second = addItem(
      h.db,
      { key: "manual:u", project: "shop", title: "And this" },
      T0.toISOString(),
    );
    setSession(h.db, second.id, { sessionId: "sess-1", workspaceId: "ws-1" }, T0.toISOString());

    await h.asking.onStatus({
      sessionId: "sess-1",
      runtimeStatus: "awaiting_input",
      previousRuntimeStatus: "running",
    });
    expect(h.events).toEqual([
      [
        "today.needs_you",
        expect.objectContaining({ title: "Needs your answer · Ship it (+1 in its stack)" }),
      ],
    ]);
  });

  test("an unanswered question reaches your phone once, after 10 minutes", async () => {
    const h = harness();
    await h.asking.ask(h.item(), "Which one?");
    h.calls.length = 0;

    h.advance(9);
    expect(await h.asking.phoneSweep()).toBe(0);
    h.advance(1);
    expect(await h.asking.phoneSweep()).toBe(1);
    expect(h.calls).toEqual([
      [
        "notify.send",
        { title: "Needs your answer", message: "Ship it\n\nWhich one?", source: "today" },
      ],
    ]);
    h.advance(5);
    expect(await h.asking.phoneSweep()).toBe(0);
  });

  test("sessions with no item on the board are ignored", async () => {
    const h = harness();
    await h.asking.onStatus({
      sessionId: "other",
      runtimeStatus: "running",
      previousRuntimeStatus: "idle",
    });
    expect(h.calls).toEqual([]);
  });
});

describe("status rules", () => {
  test("an answer is a new turn after one ended", () => {
    expect(
      isAnswer({ sessionId: "s", runtimeStatus: "running", previousRuntimeStatus: "idle" }),
    ).toBe(true);
    expect(
      isAnswer({ sessionId: "s", runtimeStatus: "running", previousRuntimeStatus: "completed" }),
    ).toBe(true);
    expect(isAnswer({ sessionId: "s", runtimeStatus: "running" })).toBe(false);
    expect(
      isAnswer({ sessionId: "s", runtimeStatus: "running", previousRuntimeStatus: "running" }),
    ).toBe(false);
    expect(
      isAnswer({
        sessionId: "s",
        runtimeStatus: "running",
        previousRuntimeStatus: "awaiting_input",
      }),
    ).toBe(false);
  });

  test("a waiting prompt is a transition into one", () => {
    expect(
      isPromptWaiting({
        sessionId: "s",
        runtimeStatus: "awaiting_input",
        previousRuntimeStatus: "running",
      }),
    ).toBe(true);
    expect(isPromptWaiting({ sessionId: "s", runtimeStatus: "awaiting_input" })).toBe(false);
  });
});
