/**
 * A CLI session reports the background work it waits on between turns,
 * so the closers leave it alone. Drives a real ClaudeCliSession's ledger with
 * entries recorded from Claude Code 2.1.325 (fixtures/background-work.jsonl);
 * no tmux, no proxy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldByBackgroundWork } from "@anima/shared";
import { backgroundChanges, writeBackgroundSnapshot } from "./background-work";
import { SessionJsonlTail, entryTime } from "./jsonl-tail";
import { ClaudeCliSession } from "./session";

const ID = "bg-test-session-0001";
const HOUR = 60 * 60 * 1000;
const LINES = readFileSync(join(import.meta.dir, "fixtures", "background-work.jsonl"), "utf8")
  .trim()
  .split("\n");
const [monitorStarted, monitorEnded] = LINES.map((l) => JSON.parse(l) as Record<string, unknown>);

interface TestSession {
  tail: SessionJsonlTail;
  getInfo(): { backgroundTasks?: number };
  resetBackground(): void;
  replayBackgroundHistory(): void;
}

const sessions: TestSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.tail.stop();
});

/** A session whose `claude` counts as running, with snapshots in a temp folder. */
function session(opts: { running?: boolean; backgroundDir?: string | null } = {}): {
  s: TestSession;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "anima-bg-session-"));
  const backgroundDir = opts.backgroundDir === null ? undefined : (opts.backgroundDir ?? dir);
  const s = new ClaudeCliSession(
    ID,
    { cwd: "/tmp/anima-bg-test", model: "claude-haiku-4-5" },
    true,
    { backgroundDir },
  ) as unknown as TestSession;
  Object.defineProperty(s, "isProcessRunning", { get: () => opts.running ?? true });
  sessions.push(s);
  return { s, dir };
}

/** What the session's own tail emits for a transcript entry. */
function written(s: TestSession, entry: Record<string, unknown>): void {
  s.tail.emit("background", backgroundChanges(entry), entryTime(entry));
}

describe("ClaudeCliSession background work", () => {
  test("a live Monitor holds the session until its notification arrives", () => {
    const { s } = session();
    expect(s.getInfo().backgroundTasks).toBe(0);
    expect(heldByBackgroundWork(s.getInfo().backgroundTasks, HOUR)).toBe(false);

    written(s, monitorStarted);
    expect(s.getInfo().backgroundTasks).toBe(1);
    expect(heldByBackgroundWork(s.getInfo().backgroundTasks, HOUR)).toBe(true);

    written(s, monitorEnded);
    expect(s.getInfo().backgroundTasks).toBe(0);
    expect(heldByBackgroundWork(s.getInfo().backgroundTasks, HOUR)).toBe(false);
  });

  test("counts what the Stop hook's snapshot lists", () => {
    const { s, dir } = session();
    writeBackgroundSnapshot(join(dir, `${ID}.json`), {
      at: Date.now(),
      tasks: [{ id: "b495k5rzz", type: "shell", description: "probe monitor" }],
      crons: [{ id: "2fe56148", recurring: false }],
    });
    expect(s.getInfo().backgroundTasks).toBe(2);
  });

  test("a relaunch forgets everything, snapshot file included", () => {
    const { s, dir } = session();
    const path = join(dir, `${ID}.json`);
    writeBackgroundSnapshot(path, {
      // A turn's end before the Monitor's start, so the start counts on top.
      at: entryTime(monitorStarted) - 60_000,
      tasks: [{ id: "b1", type: "shell", description: "" }],
      crons: [],
    });
    written(s, monitorStarted);
    expect(s.getInfo().backgroundTasks).toBe(2);
    s.resetBackground();
    expect(existsSync(path)).toBe(false);
    expect(s.getInfo().backgroundTasks).toBe(0);
  });

  test("nothing runs in background when claude isn't running", () => {
    const { s } = session({ running: false });
    written(s, monitorStarted);
    expect(s.getInfo().backgroundTasks).toBe(0);
  });

  test("no opinion without a snapshot folder", () => {
    const { s } = session({ backgroundDir: null });
    expect(s.getInfo().backgroundTasks).toBeUndefined();
  });

  test("adopting a live claude picks up a Monitor from the transcript's history", () => {
    const { s } = session();
    const file = join(mkdtempSync(join(tmpdir(), "anima-bg-history-")), "session.jsonl");
    writeFileSync(file, `${LINES[0]}\n`);
    s.tail = new SessionJsonlTail("/x", ID, file);
    s.tail.start();
    s.replayBackgroundHistory();
    expect(s.getInfo().backgroundTasks).toBe(1);
  });
});
