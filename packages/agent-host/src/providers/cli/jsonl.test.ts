import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEntry, resolveOwnSessionPath } from "./jsonl";

/** A real give-up entry from Claude Code v2.1.317 (paths and ids genericized). */
const API_ERROR_LINE = readFileSync(
  join(import.meta.dir, "fixtures", "api-error-entry.jsonl"),
  "utf8",
);

describe("resolveOwnSessionPath", () => {
  test("builds canonical ~/.claude/projects/<enc>/<id>.jsonl when nothing exists", () => {
    const p = resolveOwnSessionPath("/tmp/anima-no-such-dir-xyz", "abc-123");
    expect(p.endsWith("/.claude/projects/-tmp-anima-no-such-dir-xyz/abc-123.jsonl")).toBe(true);
  });
});

describe("classifyEntry", () => {
  test("normal user prompt (array content)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello team" }] },
      timestamp: "2026-05-29T19:00:00.000Z",
    });
    expect(classifyEntry(line)).toEqual({
      kind: "user_prompt",
      text: "hello team",
      timestamp: "2026-05-29T19:00:00.000Z",
    });
  });

  test("normal user prompt (string content)", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
    expect(classifyEntry(line)).toEqual({ kind: "user_prompt", text: "hi", timestamp: undefined });
  });

  test("interrupt marker (text response)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      interruptedMessageId: "msg_test_01",
    });
    expect(classifyEntry(line)).toMatchObject({ kind: "interrupt", forToolUse: false });
  });

  test("interrupt marker (for tool use)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
      interruptedMessageId: "msg_test_02",
    });
    expect(classifyEntry(line)).toMatchObject({ kind: "interrupt", forToolUse: true });
  });

  test("tool_result continuation is not a prompt", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    });
    expect(classifyEntry(line)).toEqual({ kind: "other" });
  });

  test("queue enqueue carries content", () => {
    const line = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      content: "steer this",
      timestamp: "2026-05-12T16:10:19.067Z",
    });
    expect(classifyEntry(line)).toEqual({
      kind: "enqueue",
      content: "steer this",
      timestamp: "2026-05-12T16:10:19.067Z",
    });
  });

  test("queue dequeue and remove", () => {
    expect(
      classifyEntry(JSON.stringify({ type: "queue-operation", operation: "dequeue" })),
    ).toEqual({ kind: "dequeue", timestamp: undefined });
    expect(classifyEntry(JSON.stringify({ type: "queue-operation", operation: "remove" }))).toEqual(
      { kind: "remove", timestamp: undefined },
    );
  });

  test("main-thread assistant entries are assistant, sidechain ones and summaries other", () => {
    expect(
      classifyEntry(JSON.stringify({ type: "assistant", message: {}, timestamp: "t1" })),
    ).toEqual({ kind: "assistant", timestamp: "t1" });
    expect(
      classifyEntry(JSON.stringify({ type: "assistant", isSidechain: true, message: {} })),
    ).toEqual({ kind: "other" });
    expect(classifyEntry(JSON.stringify({ type: "summary", summary: "x" }))).toEqual({
      kind: "other",
    });
  });

  test("API give-up entry (real shape) is api_error with its fields", () => {
    expect(classifyEntry(API_ERROR_LINE)).toEqual({
      kind: "api_error",
      error: "server_error",
      apiError: "connection_failed",
      streamCutCause: "stale_connection",
      text: "API Error: Connection lost mid-response. The response above may be incomplete.",
      timestamp: "2026-11-03T22:41:08.408Z",
    });
  });

  test("API give-up entry without the optional fields", () => {
    const entry = JSON.parse(API_ERROR_LINE) as Record<string, unknown>;
    delete entry.apiError;
    delete entry.streamCutCause;
    entry.message = {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: "API Error: 502 proxy upstream error" }],
    };
    expect(classifyEntry(JSON.stringify(entry))).toMatchObject({
      kind: "api_error",
      error: "server_error",
      apiError: undefined,
      streamCutCause: undefined,
      text: "API Error: 502 proxy upstream error",
    });
  });

  test("a subagent's (sidechain) API error is not ours", () => {
    const entry = JSON.parse(API_ERROR_LINE) as Record<string, unknown>;
    entry.isSidechain = true;
    expect(classifyEntry(JSON.stringify(entry))).toEqual({ kind: "other" });
  });

  test("system/turn_duration is turn_end; other system entries are other", () => {
    expect(
      classifyEntry(JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: "t2" })),
    ).toEqual({ kind: "turn_end", timestamp: "t2" });
    expect(classifyEntry(JSON.stringify({ type: "system", subtype: "compact_boundary" }))).toEqual({
      kind: "other",
    });
  });

  test("a compaction summary is a user entry nobody sent: other, not a prompt", () => {
    const summary = {
      type: "user",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation.",
      },
    };
    expect(classifyEntry(JSON.stringify(summary))).toEqual({ kind: "other" });
  });

  test("blank and unparseable lines return null", () => {
    expect(classifyEntry("")).toBeNull();
    expect(classifyEntry("   ")).toBeNull();
    expect(classifyEntry("{not json")).toBeNull();
  });
});
