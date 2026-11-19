/**
 * Background work, against entries and hook input recorded from Claude
 * Code 2.1.325 (fixtures/background-work.jsonl, fixtures/stop-hook-inputs.json).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundLedger,
  BackgroundSnapshotReader,
  type BackgroundSnapshot,
  WAKEUP_ID,
  backgroundChanges,
  backgroundSnapshotPath,
  endedTaskIds,
  snapshotFromStopInput,
  writeBackgroundSnapshot,
} from "./background-work";
import { entryTime } from "./jsonl-tail";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const ENTRIES = fixture("background-work.jsonl")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const [
  monitorStarted,
  monitorEndQueued,
  monitorEndWakes,
  longMonitorStarted,
  longMonitorStopped,
  shellStarted,
  cronCreated,
  agentStarted,
  cronFired,
] = ENTRIES;
const STOP_INPUTS = JSON.parse(fixture("stop-hook-inputs.json")) as Record<string, unknown>;

const at = (entry: Record<string, unknown>): number => entryTime(entry);
const snapshot = (atMs: number, taskIds: string[], cronIds: string[] = []): BackgroundSnapshot => ({
  at: atMs,
  tasks: taskIds.map((id) => ({ id, type: "shell", description: "" })),
  crons: cronIds.map((id) => ({ id, recurring: false })),
});

describe("backgroundChanges (recorded entries)", () => {
  test("a Monitor start names its task", () => {
    expect(backgroundChanges(monitorStarted)).toEqual({
      started: [{ id: "b8nzo6c9d" }],
      ended: [],
    });
  });

  test("its notification ends it, queued or waking an idle session", () => {
    expect(backgroundChanges(monitorEndQueued).ended).toEqual(["b8nzo6c9d"]);
    expect(backgroundChanges(monitorEndWakes).ended).toEqual(["b8nzo6c9d"]);
  });

  test("TaskStop ends the task it names", () => {
    expect(backgroundChanges(longMonitorStarted).started).toEqual([{ id: "bkjq1dt11" }]);
    expect(backgroundChanges(longMonitorStopped)).toEqual({ started: [], ended: ["bkjq1dt11"] });
  });

  test("background shells, subagents and crons start too", () => {
    expect(backgroundChanges(shellStarted).started).toEqual([{ id: "b4lvv6fwp" }]);
    expect(backgroundChanges(agentStarted).started).toEqual([{ id: "a0000000000000001" }]);
    expect(backgroundChanges(cronCreated).started).toEqual([{ id: "9ad41478", recurring: false }]);
    expect(backgroundChanges(cronFired).ended).toEqual(["9ad41478"]);
  });

  test("/loop wakeups: scheduled, fired, stopped", () => {
    const wake = (result: Record<string, unknown>) =>
      backgroundChanges({ type: "user", message: { content: [] }, toolUseResult: result });
    expect(
      wake({ scheduledFor: 1794854640000, clampedDelaySeconds: 60, wasClamped: false }),
    ).toEqual({ started: [{ id: WAKEUP_ID }], ended: [] });
    expect(
      wake({
        scheduledFor: 0,
        clampedDelaySeconds: 0,
        wasClamped: false,
        stopped: true,
        cancelledWakeups: 1,
      }),
    ).toEqual({ started: [], ended: [WAKEUP_ID] });
    const fired = backgroundChanges({
      type: "system",
      subtype: "scheduled_task_fire",
      taskId: "2da28659",
      taskKind: "loop",
    });
    expect(fired.ended).toEqual(["2da28659", WAKEUP_ID]);
  });

  test("a Monitor event that doesn't end it, and unrelated entries, change nothing", () => {
    const event =
      "<task-notification>\n<task-id>b1</task-id>\n<status>running</status>\n<event>tick</event>\n</task-notification>";
    expect(endedTaskIds(event)).toEqual([]);
    expect(
      backgroundChanges({ type: "queue-operation", operation: "enqueue", content: "hi" }),
    ).toEqual({ started: [], ended: [] });
    // A foreground Agent finished in its own call: nothing to wait for.
    const foreground = { type: "user", toolUseResult: { status: "completed", agentId: "a1" } };
    expect(backgroundChanges(foreground).started).toEqual([]);
    // A subagent's own entries aren't the session's.
    expect(backgroundChanges({ ...monitorStarted, isSidechain: true }).started).toEqual([]);
  });
});

describe("BackgroundLedger", () => {
  const feed = (ledger: BackgroundLedger, ...entries: Record<string, unknown>[]) => {
    for (const e of entries) ledger.apply(backgroundChanges(e), at(e));
  };

  test("a Monitor is open from its start until its notification", () => {
    const ledger = new BackgroundLedger();
    feed(ledger, monitorStarted);
    expect(ledger.open()).toEqual(["b8nzo6c9d"]);
    feed(ledger, monitorEndQueued, monitorEndWakes);
    expect(ledger.open()).toEqual([]);
  });

  test("the Stop snapshot replaces what came before it", () => {
    const ledger = new BackgroundLedger();
    feed(ledger, monitorStarted); // started 18:32:53
    ledger.setSnapshot(snapshot(at(monitorStarted) + 1000, ["b8nzo6c9d", "fromRegistry"]));
    expect(ledger.open().sort()).toEqual(["b8nzo6c9d", "fromRegistry"]);
    // An entry older than the snapshot is already in it.
    feed(ledger, monitorStarted);
    expect(ledger.open()).toHaveLength(2);
    // An end after it still counts.
    feed(ledger, monitorEndQueued);
    expect(ledger.open()).toEqual(["fromRegistry"]);
  });

  test("a snapshot drops earlier starts it doesn't list", () => {
    // The guard against a stuck count: a start whose end we never parse is
    // cleared by the next Stop snapshot that no longer lists it.
    const ledger = new BackgroundLedger();
    feed(ledger, monitorStarted);
    ledger.setSnapshot(snapshot(at(monitorStarted) + 1000, []));
    expect(ledger.open()).toEqual([]);
    // A start older than the snapshot that the tail delivers late changes nothing.
    feed(ledger, monitorStarted);
    expect(ledger.open()).toEqual([]);
  });

  test("work started in an interrupted turn (no Stop) is still counted", () => {
    const ledger = new BackgroundLedger();
    ledger.setSnapshot(snapshot(at(monitorStarted) - 60_000, []));
    feed(ledger, monitorStarted);
    expect(ledger.open()).toEqual(["b8nzo6c9d"]);
  });

  test("an older snapshot never overrides a newer one", () => {
    const ledger = new BackgroundLedger();
    ledger.setSnapshot(snapshot(2000, []));
    ledger.setSnapshot(snapshot(1000, ["stale"]));
    expect(ledger.open()).toEqual([]);
  });

  test("a recurring cron stays open when it fires", () => {
    const ledger = new BackgroundLedger();
    ledger.setSnapshot({ at: 1000, tasks: [], crons: [{ id: "c1", recurring: true }] });
    ledger.apply({ started: [], ended: ["c1"] }, 2000);
    expect(ledger.open()).toEqual(["c1"]);
    const oneShot = new BackgroundLedger();
    feed(oneShot, cronCreated, cronFired);
    expect(oneShot.open()).toEqual([]);
  });

  test("clear forgets everything (claude relaunched)", () => {
    const ledger = new BackgroundLedger();
    ledger.setSnapshot(snapshot(1000, ["a"]));
    feed(ledger, monitorStarted);
    ledger.clear();
    expect(ledger.open()).toEqual([]);
  });
});

describe("Stop hook snapshots", () => {
  test("reads the registry from recorded hook input", () => {
    const parsed = snapshotFromStopInput(STOP_INPUTS.twoShells, 5000);
    expect(parsed?.sessionId).toBe("00000000-0000-4000-8000-000000000215");
    expect(parsed?.snapshot.tasks.map((t) => [t.id, t.description])).toEqual([
      ["b4lvv6fwp", "Sleep 35 seconds then print shell-done"],
      ["b495k5rzz", "probe monitor"],
    ]);
    const withCron = snapshotFromStopInput(STOP_INPUTS.agentAndCron, 5000)?.snapshot;
    expect(withCron?.tasks.map((t) => t.type)).toEqual(["subagent"]);
    expect(withCron?.crons).toEqual([{ id: "9ad41478", recurring: false }]);
  });

  test("ignores other events and CLIs that send no registry", () => {
    const input = STOP_INPUTS.twoShells as Record<string, unknown>;
    expect(snapshotFromStopInput({ ...input, hook_event_name: "SubagentStop" }, 1)).toBeNull();
    const { background_tasks: _t, session_crons: _c, ...old } = input;
    expect(snapshotFromStopInput(old, 1)).toBeNull();
  });

  test("only a session id can name a snapshot file", () => {
    expect(backgroundSnapshotPath("/d", "../../etc/passwd")).toBeNull();
    expect(backgroundSnapshotPath("/d", "00000000-0000-4000-8000-000000000204")).toBe(
      "/d/00000000-0000-4000-8000-000000000204.json",
    );
  });

  test("the reader reports a written snapshot once per change", () => {
    const path = join(mkdtempSync(join(tmpdir(), "anima-bg-")), "s.json");
    const reader = new BackgroundSnapshotReader(path);
    expect(reader.readIfChanged()).toBeNull();
    writeBackgroundSnapshot(path, snapshot(1000, ["a"]));
    expect(reader.readIfChanged()?.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(reader.readIfChanged()).toBeNull();
    writeBackgroundSnapshot(path, snapshot(2000, []));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(reader.readIfChanged()?.at).toBe(2000);
  });
});
