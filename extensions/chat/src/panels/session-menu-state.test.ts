import { describe, expect, test } from "bun:test";
import type { AttentionSession, SessionInfo } from "@anima/ui";
import { sessionMenuState } from "./session-menu-state";

const ID = "0f3c9a12-aaaa-bbbb-cccc-1234567890ab";

function queued(overrides: Partial<AttentionSession> = {}): AttentionSession {
  return {
    sessionId: ID,
    workspaceId: "w1",
    workspaceName: "anima",
    cwd: "/repo",
    title: null,
    firstPrompt: "Fix the session menu",
    runtimeStatus: "idle",
    disposition: "open",
    lastActivity: "2026-11-13T20:00:00Z",
    waitingSince: "2026-11-13T20:00:00Z",
    snoozedUntil: null,
    pinned: false,
    ...overrides,
  };
}

describe("sessionMenuState", () => {
  test("a queued session: the queue's status, title and pin win over a stale list row", () => {
    const listed: SessionInfo = { sessionId: ID, title: "Old name", disposition: "open" };
    const state = sessionMenuState(
      ID,
      listed,
      queued({ title: "New name", disposition: "blocked", pinned: true }),
    );
    expect(state).toEqual({
      disposition: "blocked",
      heading: "New name",
      title: "New name",
      derivedName: "Fix the session menu",
      pinned: true,
    });
  });

  test("a resolved session is out of the queue: list row only, and nothing to pin", () => {
    const listed: SessionInfo = { sessionId: ID, firstPrompt: "Ship it", disposition: "resolved" };
    const state = sessionMenuState(ID, listed, undefined);
    expect(state.disposition).toBe("resolved");
    expect(state.heading).toBe("Ship it");
    expect(state.title).toBe("");
    expect(state.pinned).toBeUndefined();
  });

  test("a cleared title in the queue falls back to the derived name", () => {
    const listed: SessionInfo = { sessionId: ID, title: "Stale title" };
    const state = sessionMenuState(ID, listed, queued({ title: null }));
    expect(state.title).toBe("");
    expect(state.heading).toBe("Fix the session menu");
  });

  test("known to neither source (opened by URL past the first page): still usable", () => {
    const state = sessionMenuState(ID, undefined, undefined);
    expect(state).toEqual({
      disposition: "open",
      heading: "0f3c9a12",
      title: "",
      derivedName: "0f3c9a12",
      pinned: undefined,
    });
  });
});
