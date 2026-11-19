import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  parseSessionFile,
  parseSessionFilePaginated,
  parseSessionUsage,
  resolveSessionPath,
  type HistoryMessage,
} from "./parse-session";

function writeSessionFile(lines: string[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "anima-parse-session-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return { dir, file };
}

function textOf(message: HistoryMessage): string | undefined {
  const block = message.blocks[0];
  return block?.type === "text" ? block.content : undefined;
}

describe("parse-session", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("parses user/assistant messages, compaction boundaries, and tool results", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-02-22T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Starting..." },
            { type: "tool_use", id: "tool-1", name: "ReadFile", input: { path: "README.md" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-02-22T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file content" }],
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-02-22T00:00:03.000Z",
        compact_metadata: { trigger: "manual", pre_tokens: 1234 },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-02-22T00:00:04.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Continue please" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-02-22T00:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "planning..." },
            { type: "text", text: "Done." },
          ],
        },
      }),
    ]);
    dirs.push(dir);

    const messages = parseSessionFile(file);
    expect(messages).toHaveLength(4);

    expect(messages[0]?.role).toBe("assistant");
    const toolUse = messages[0]?.blocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "tool-1",
      name: "ReadFile",
      result: { content: "file content" },
    });

    expect(messages[1]).toEqual({
      role: "compaction_boundary",
      blocks: [],
      timestamp: "2026-02-22T00:00:03.000Z",
      compaction: { trigger: "manual", pre_tokens: 1234 },
    });

    expect(messages[2]?.role).toBe("user");
    expect(messages[3]?.role).toBe("assistant");
  });

  it("folds a compaction's summary into its divider instead of showing it as the user's message", () => {
    // The shape Claude Code writes: the boundary, then the summary as a
    // user entry flagged isCompactSummary, then the conversation goes on.
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-13T22:00:00.000Z",
        message: { role: "user", content: "before" },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-11-13T22:06:48.969Z",
        compactMetadata: { trigger: "auto", preTokens: 300000, postTokens: 30000 },
      }),
      JSON.stringify({
        type: "user",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        timestamp: "2026-11-13T22:06:48.964Z",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation.\n\n## Summary\n- the board",
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-13T22:30:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "after" }] },
      }),
    ]);
    dirs.push(dir);

    const messages = parseSessionFile(file);
    expect(messages.map((m) => m.role)).toEqual(["user", "compaction_boundary", "user"]);
    expect(messages[1]?.compaction).toEqual({
      trigger: "auto",
      pre_tokens: 300000,
      summary:
        "This session is being continued from a previous conversation.\n\n## Summary\n- the board",
    });
    expect(messages[2]?.blocks).toEqual([{ type: "text", content: "after" }]);
  });

  it("a summary with no boundary before it still becomes a divider", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "user",
        isCompactSummary: true,
        message: { role: "user", content: [{ type: "text", text: "notes" }] },
      }),
    ]);
    dirs.push(dir);
    expect(parseSessionFile(file)).toEqual([
      {
        role: "compaction_boundary",
        blocks: [],
        timestamp: undefined,
        compaction: { trigger: "auto", pre_tokens: 0, summary: "notes" },
      },
    ]);
  });

  it("skips malformed/meta/synthetic-only entries and supports pagination", () => {
    const { dir, file } = writeSessionFile([
      "not-json",
      JSON.stringify({
        type: "assistant",
        isMeta: true,
        message: { role: "assistant", content: [{ type: "text", text: "meta" }] },
      }),
      JSON.stringify({
        type: "user",
        isSynthetic: true,
        message: { role: "user", content: [{ type: "text", text: "synthetic" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "first" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "third" },
      }),
    ]);
    dirs.push(dir);

    const all = parseSessionFile(file);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    const page = parseSessionFilePaginated(file, { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.start).toBe(1);
    expect(page.messages.map((m) => m.role)).toEqual(["assistant", "user"]);

    const older = parseSessionFilePaginated(file, { limit: 2, before: page.start });
    expect(older.start).toBe(0);
    expect(older.hasMore).toBe(false);
    expect(older.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("pages back from the latest message to the first, each message once and in order", () => {
    const lines: string[] = [];
    for (let i = 0; i < 123; i++) {
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? "user" : "assistant",
          message: {
            role: i % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `m${i}` }],
          },
        }),
      );
    }
    const { dir, file } = writeSessionFile(lines);
    dirs.push(dir);

    let page = parseSessionFilePaginated(file, { limit: 50 });
    const loaded = [...page.messages];
    const starts = [page.start];
    while (page.hasMore) {
      page = parseSessionFilePaginated(file, { limit: 50, before: page.start });
      loaded.unshift(...page.messages);
      starts.push(page.start);
    }
    expect(starts).toEqual([73, 23, 0]);
    const texts = loaded.map((m) => textOf(m));
    expect(texts).toEqual(Array.from({ length: 123 }, (_, i) => `m${i}`));
  });

  it("keeps an older page's cursor valid while the session grows", () => {
    const entry = (text: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const { dir, file } = writeSessionFile(["a", "b", "c", "d"].map(entry));
    dirs.push(dir);

    const latest = parseSessionFilePaginated(file, { limit: 2 });
    expect(latest.start).toBe(2);
    writeFileSync(file, ["a", "b", "c", "d", "e", "f"].map(entry).join("\n") + "\n");

    const older = parseSessionFilePaginated(file, { limit: 2, before: latest.start });
    expect(older.messages.map((m) => textOf(m))).toEqual(["a", "b"]);
  });

  it("extracts the last assistant usage block", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "A" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-13T23:10:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "B" }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 2,
            output_tokens: 20,
          },
        },
      }),
    ]);
    dirs.push(dir);

    expect(parseSessionUsage(file)).toEqual({
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        output_tokens: 20,
      },
      at: "2026-11-13T23:10:00.000Z",
    });
  });

  it("takes the context size from a compaction after the last model call", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-13T21:12:17.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "A" }],
          usage: { input_tokens: 5, cache_read_input_tokens: 316_000, output_tokens: 9 },
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-11-13T22:06:48.969Z",
        compactMetadata: { trigger: "auto", preTokens: 317_014, postTokens: 29_076 },
      }),
    ]);
    dirs.push(dir);

    expect(parseSessionUsage(file)).toEqual({
      usage: {
        input_tokens: 29_076,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      at: "2026-11-13T22:06:48.969Z",
    });
  });

  it("parses rich user blocks and tool result arrays, and keeps mixed user content", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-02-22T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-rich", name: "Read", input: "raw" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-02-22T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-rich",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "line2" },
              ],
              is_error: true,
            },
            { type: "text", text: "follow-up text" },
            {
              type: "image",
              source: { media_type: "image/jpeg", data: "abc123" },
            },
            {
              type: "document",
              filename: "doc.bin",
              source: { media_type: "application/pdf", data: "xyz789" },
            },
            "string block",
          ],
        },
      }),
    ]);
    dirs.push(dir);

    const messages = parseSessionFile(file);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks.find((b) => b.type === "tool_use")).toMatchObject({
      type: "tool_use",
      id: "tool-rich",
      result: { content: "line1\nline2", is_error: true },
    });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.blocks.some((b) => b.type === "image")).toBe(true);
    expect(messages[1]?.blocks.some((b) => b.type === "file")).toBe(true);
    expect(messages[1]?.blocks.some((b) => b.type === "text")).toBe(true);
  });

  it("handles empty pagination, malformed usage lines, and path resolution modes", () => {
    const { dir, file } = writeSessionFile([
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
    ]);
    dirs.push(dir);

    const emptyPage = parseSessionFilePaginated(file, { limit: 10 });
    expect(emptyPage).toEqual({ messages: [], total: 0, hasMore: false, start: 0 });

    const usageFile = join(dir, "usage.jsonl");
    writeFileSync(
      usageFile,
      [
        "not json",
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [], usage: { output_tokens: 5 } },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    expect(parseSessionUsage(usageFile)).toEqual({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      },
      at: null,
    });

    // Full-path resolution
    expect(resolveSessionPath(file)).toBe(file);
    expect(resolveSessionPath(join(dir, "missing.jsonl"))).toBeNull();

    // CWD-derived and recursive fallback resolution
    const cwd = `/tmp/anima-parse-${Date.now()}`;
    const encoded = cwd.replace(/\//g, "-");
    const projectsDir = join(homedir(), ".claude", "projects");
    const directDir = join(projectsDir, encoded);
    const directFile = join(directDir, "sid-direct.jsonl");
    mkdirSync(directDir, { recursive: true });
    writeFileSync(directFile, "{}\n", "utf-8");
    expect(existsSync(directFile)).toBe(true);
    expect(resolveSessionPath("sid-direct", cwd)).toBe(directFile);

    const scanDir = join(projectsDir, `scan-${Date.now()}`);
    const scanFile = join(scanDir, "sid-scan.jsonl");
    mkdirSync(scanDir, { recursive: true });
    writeFileSync(scanFile, "{}\n", "utf-8");
    expect(resolveSessionPath("sid-scan", "/tmp/no-match-cwd")).toBe(scanFile);

    rmSync(directDir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  });
});
