import { describe, expect, test } from "bun:test";
import { parseTmuxSessions, type TmuxSessionInfo } from "./providers/cli/tmux";
import { reapVerdict, type ReapContext } from "./tmux-reaper";
import { configurePanePrefix } from "./pane-names";

const NOW = 1_800_000_000;
const HOUR = 3600;
const LIVE = "11111111-1111-1111-1111-111111111111";
const GONE = "22222222-2222-2222-2222-222222222222";

function pane(name: string, idleSec: number, extra: Partial<TmuxSessionInfo> = {}) {
  return { name, activitySec: NOW - idleSec, attached: false, busy: false, ...extra };
}

const ctx: ReapContext = {
  nowSec: NOW,
  staleMs: 2 * HOUR * 1000,
  isTracked: (id) => id === LIVE,
  claudeAlive: (id) => id === LIVE,
};

describe("reapVerdict", () => {
  test("ignores panes that aren't Anima's", () => {
    configurePanePrefix(undefined);
    expect(reapVerdict(pane("other-app", 10 * HOUR), ctx)).toBeNull();
  });

  test("only touches panes with this instance's prefix", () => {
    configurePanePrefix("open-anima");
    try {
      // Another instance's abandoned panes: not ours, whatever their state.
      expect(reapVerdict(pane("anima-wrapper-" + GONE, 10 * HOUR), ctx)).toBeNull();
      expect(reapVerdict(pane("anima-claude-" + GONE, 10 * HOUR), ctx)).toBeNull();
      expect(reapVerdict(pane("open-anima-wrapper-" + GONE, 6 * 60), ctx)).toBe("orphan-wrapper");
      expect(reapVerdict(pane("open-anima-claude-" + GONE, 3 * HOUR), ctx)).toBe(
        "claude-untracked",
      );
    } finally {
      configurePanePrefix(undefined);
    }
  });

  test("a wrapper whose session is gone goes after five quiet minutes", () => {
    expect(reapVerdict(pane(`anima-wrapper-${GONE}`, 4 * 60), ctx)).toBeNull();
    expect(reapVerdict(pane(`anima-wrapper-${GONE}`, 6 * 60), ctx)).toBe("orphan-wrapper");
  });

  test("a live session's wrapper waits for the full idle threshold", () => {
    expect(reapVerdict(pane(`anima-wrapper-${LIVE}`, HOUR), ctx)).toBeNull();
    expect(reapVerdict(pane(`anima-wrapper-${LIVE}`, 3 * HOUR), ctx)).toBe("wrapper");
  });

  test("a subagent wrapper goes after fifteen minutes, sooner when its parent is gone", () => {
    expect(reapVerdict(pane(`anima-wrapper-${LIVE}-sub-abc`, 10 * 60), ctx)).toBeNull();
    expect(reapVerdict(pane(`anima-wrapper-${LIVE}-sub-abc`, 16 * 60), ctx)).toBe(
      "subagent-wrapper",
    );
    expect(reapVerdict(pane(`anima-wrapper-${GONE}-sub-abc`, 6 * 60), ctx)).toBe("orphan-wrapper");
  });

  test("never kills a wrapper that is running a command, or one someone is attached to", () => {
    expect(reapVerdict(pane(`anima-wrapper-${GONE}`, 10 * HOUR, { busy: true }), ctx)).toBeNull();
    expect(
      reapVerdict(pane(`anima-wrapper-${GONE}`, 10 * HOUR, { attached: true }), ctx),
    ).toBeNull();
  });

  test("a CLI pane with a live claude is never reaped, however idle", () => {
    expect(reapVerdict(pane(`anima-claude-${LIVE}`, 10 * HOUR), ctx)).toBeNull();
    const untrackedButAlive = { ...ctx, isTracked: () => false };
    expect(reapVerdict(pane(`anima-claude-${LIVE}`, 10 * HOUR), untrackedButAlive)).toBeNull();
  });

  test("an abandoned CLI pane goes after the full idle threshold", () => {
    expect(reapVerdict(pane(`anima-claude-${GONE}`, HOUR), ctx)).toBeNull();
    expect(reapVerdict(pane(`anima-claude-${GONE}`, 3 * HOUR), ctx)).toBe("claude-untracked");
  });
});

describe("parseTmuxSessions", () => {
  test("takes the later of session and window activity, and marks busy wrappers", () => {
    const sessions = [
      `anima-wrapper-${GONE}\t100\t500\t0`,
      `anima-claude-${LIVE}\t900\t200\t1`,
    ].join("\n");
    const panes = [
      `anima-wrapper-${GONE}\tidle\tzsh`,
      `anima-wrapper-${GONE}\tbusy\tbash`,
      `anima-claude-${LIVE}\t\t2.1.318`,
    ].join("\n");
    expect(parseTmuxSessions(sessions, panes)).toEqual([
      { name: `anima-wrapper-${GONE}`, activitySec: 500, attached: false, busy: true },
      { name: `anima-claude-${LIVE}`, activitySec: 900, attached: true, busy: false },
    ]);
  });

  test("a busy mark left on a pane back at its login shell is stale", () => {
    const sessions = `anima-wrapper-${GONE}\t100\t500\t0`;
    const panes = `anima-wrapper-${GONE}\tbusy\tzsh`;
    expect(parseTmuxSessions(sessions, panes)[0]?.busy).toBe(false);
  });
});
