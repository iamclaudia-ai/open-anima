/**
 * Parse Claude Code session JSONL files into UI-friendly Message[] format.
 *
 * Reads the JSONL files that Claude Code writes to ~/.claude/projects/ and
 * transforms them into the same Message/ContentBlock structure the UI expects.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { claudeProjectDir } from "@anima/shared";

// ── Types matching @anima/ui ──────────────────────────────

interface TextBlock {
  type: "text" | "thinking";
  content: string;
}

interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string;
}

interface FileBlock {
  type: "file";
  mediaType: string;
  data: string;
  filename?: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: string;
  result?: {
    content: string;
    is_error?: boolean;
  };
}

type ContentBlock = TextBlock | ImageBlock | FileBlock | ToolUseBlock;

export interface HistoryMessage {
  role: "user" | "assistant" | "compaction_boundary";
  blocks: ContentBlock[];
  timestamp?: string;
  /** Compaction metadata — only present when role === "compaction_boundary" */
  compaction?: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    /** The summary Claude Code carried forward, shown folded under the divider. */
    summary?: string;
  };
}

export interface HistoryUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

// ── Raw JSONL entry ─────────────────────────────────────────

interface JsonlEntry {
  type: string;
  subtype?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | unknown[];
    usage?: Record<string, number>;
  };
  /** The summary a compaction carries forward: a `user` entry, but nothing anyone typed. */
  isCompactSummary?: boolean;
  isSynthetic?: boolean;
  isMeta?: boolean;
  /** Claude Code's transcript spelling of the boundary's metadata. */
  compactMetadata?: {
    trigger?: "manual" | "auto";
    preTokens?: number;
  };
  /** The SDK stream's spelling, kept for transcripts that use it. */
  compact_metadata?: {
    trigger?: "manual" | "auto";
    pre_tokens?: number;
  };
}

/** The text of a compaction summary entry. */
function summaryText(content: string | unknown[]): string {
  return parseUserContent(content)
    .flatMap((block) => (block.type === "text" ? [block.content] : []))
    .join("\n\n");
}

// ── Parsers ─────────────────────────────────────────────────

function parseUserContent(content: string | unknown[]): ContentBlock[] {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", content }] : [];
  }

  const blocks: ContentBlock[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (typeof item === "string") {
      if ((item as string).trim()) blocks.push({ type: "text", content: item as string });
    } else if (item.type === "text" && item.text) {
      blocks.push({ type: "text", content: item.text as string });
    } else if (item.type === "image" && item.source) {
      const src = item.source as Record<string, string>;
      blocks.push({
        type: "image",
        mediaType: src.media_type || "image/png",
        data: src.data || "",
      });
    } else if (item.type === "document" && item.source) {
      const src = item.source as Record<string, string>;
      blocks.push({
        type: "file",
        mediaType: src.media_type || "application/octet-stream",
        data: src.data || "",
        filename: item.filename as string | undefined,
      });
    }
  }
  return blocks;
}

function parseAssistantContent(content: unknown[]): ContentBlock[] {
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (item.type === "text" && item.text) {
      blocks.push({ type: "text", content: item.text as string });
    } else if (item.type === "thinking") {
      // Claude Code redacts the thinking text on persistence (only signature
      // is preserved). Preserve the block anyway so the UI still shows a
      // "Thought" timeline entry — content is "" when redacted.
      blocks.push({ type: "thinking", content: (item.thinking as string) || "" });
    } else if (item.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: (item.id as string) || "",
        name: (item.name as string) || "Unknown",
        input:
          typeof item.input === "string" ? item.input : JSON.stringify(item.input || {}, null, 2),
      });
    }
  }
  return blocks;
}

function extractToolResults(
  content: unknown[],
): Map<string, { content: string; is_error?: boolean }> {
  const results = new Map<string, { content: string; is_error?: boolean }>();
  if (!Array.isArray(content)) return results;

  for (const item of content as Record<string, unknown>[]) {
    if (item.type === "tool_result" && item.tool_use_id) {
      let resultContent = "";
      if (typeof item.content === "string") {
        resultContent = item.content;
      } else if (Array.isArray(item.content)) {
        resultContent = (item.content as Record<string, unknown>[])
          .filter((c) => c.type === "text")
          .map((c) => (c.text as string) || "")
          .join("\n");
      }
      results.set(item.tool_use_id as string, {
        content: resultContent,
        is_error: item.is_error as boolean | undefined,
      });
    }
  }
  return results;
}

// ── Public API ──────────────────────────────────────────────

export interface PaginatedHistory {
  messages: HistoryMessage[];
  total: number;
  hasMore: boolean;
  /** Index of the first returned message in the whole history: the cursor for the next older page. */
  start: number;
}

/**
 * Parse a Claude Code session JSONL file into Message[] for the UI.
 */
export function parseSessionFile(filepath: string): HistoryMessage[] {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  const messages: HistoryMessage[] = [];
  const pendingToolResults = new Map<string, { content: string; is_error?: boolean }>();

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Detect compaction boundary markers
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      const meta = entry.compactMetadata;
      messages.push({
        role: "compaction_boundary",
        blocks: [],
        timestamp: entry.timestamp,
        compaction: {
          trigger: meta?.trigger || entry.compact_metadata?.trigger || "auto",
          pre_tokens: meta?.preTokens || entry.compact_metadata?.pre_tokens || 0,
        },
      });
      continue;
    }

    // The summary a compaction carries forward. It's written as a user entry right after its
    // boundary, but it isn't something the user typed: fold it into the divider instead of a
    // screen-long message.
    if (entry.type === "user" && entry.isCompactSummary) {
      const summary = entry.message?.content ? summaryText(entry.message.content) : "";
      const last = messages.at(-1);
      if (last?.role === "compaction_boundary" && last.compaction && !last.compaction.summary) {
        if (summary) last.compaction.summary = summary;
      } else {
        messages.push({
          role: "compaction_boundary",
          blocks: [],
          timestamp: entry.timestamp,
          compaction: { trigger: "auto", pre_tokens: 0, ...(summary ? { summary } : {}) },
        });
      }
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isMeta) continue;

    const message = entry.message;
    if (!message || !message.content) continue;

    // Synthetic entries are Claude Code's own, not a turn of the conversation.
    if (entry.isSynthetic) continue;

    if (entry.type === "user") {
      const toolResults = extractToolResults(message.content as unknown[]);

      if (toolResults.size > 0) {
        // Attach tool results to previous assistant's tool_use blocks
        for (const [toolId, result] of toolResults) {
          pendingToolResults.set(toolId, result);
        }
        for (const msg of messages) {
          if (msg.role === "assistant") {
            for (const block of msg.blocks) {
              if (block.type === "tool_use" && pendingToolResults.has(block.id)) {
                block.result = pendingToolResults.get(block.id);
                pendingToolResults.delete(block.id);
              }
            }
          }
        }

        // Only add if there's non-tool-result content
        const userBlocks = parseUserContent(message.content);
        const hasContent = userBlocks.some((b) => b.type === "text" || b.type === "image");
        if (hasContent) {
          messages.push({ role: "user", blocks: userBlocks, timestamp: entry.timestamp });
        }
      } else {
        const blocks = parseUserContent(message.content);
        if (blocks.length > 0) {
          messages.push({ role: "user", blocks, timestamp: entry.timestamp });
        }
      }
    } else if (entry.type === "assistant") {
      const blocks = parseAssistantContent(message.content as unknown[]);
      if (blocks.length > 0) {
        messages.push({ role: "assistant", blocks, timestamp: entry.timestamp });
      }
    }
  }

  return messages;
}

/**
 * Parse a session JSONL file with pagination support.
 *
 * Must parse ALL lines first (tool results in user messages backfill earlier
 * assistant tool_use blocks), then slice the result.
 *
 * - no `before` → the most recent `limit` messages
 * - `before: N` → the `limit` messages just before index N
 *
 * Pages are addressed by index from the start of the history, not by a count back
 * from the end: the transcript only grows at the end, so an index stays put while
 * the session keeps talking, and the client never has to know how many messages
 * it holds (streamed messages don't map one-to-one onto parsed ones).
 */
export function parseSessionFilePaginated(
  filepath: string,
  options: { limit: number; before?: number },
): PaginatedHistory {
  const allMessages = parseSessionFile(filepath);
  const total = allMessages.length;
  const { limit } = options;

  if (total === 0) {
    return { messages: [], total: 0, hasMore: false, start: 0 };
  }

  const end = Math.min(total, Math.max(0, options.before ?? total));
  const start = Math.max(0, end - limit);
  const messages = allMessages.slice(start, end);

  return { messages, total, hasMore: start > 0, start };
}

/** The context usage of a session's last model call, and when it was written. */
export interface SessionUsageSnapshot {
  usage: HistoryUsage;
  /**
   * The ISO timestamp of that last assistant entry: when the session last
   * talked to the model, so where its idle time (and prompt-cache age) starts.
   * Null when the entry has none.
   */
  at: string | null;
}

/**
 * Extract the last usage data from a session JSONL file, with its timestamp.
 */
export function parseSessionUsage(filepath: string): SessionUsageSnapshot | null {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  let last: SessionUsageSnapshot | null = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "assistant") {
      const message = entry.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, number> | undefined;
      if (usage) {
        last = {
          usage: {
            input_tokens: usage.input_tokens || 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
            cache_read_input_tokens: usage.cache_read_input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          },
          at: typeof entry.timestamp === "string" ? entry.timestamp : null,
        };
      }
    } else if (entry.type === "system" && entry.subtype === "compact_boundary") {
      // A compaction after the last model call shrank the context, and no call
      // has reported the new size yet: the boundary carries it.
      const metadata = entry.compactMetadata as Record<string, unknown> | undefined;
      const postTokens = metadata?.postTokens;
      if (typeof postTokens === "number") {
        last = {
          usage: {
            input_tokens: postTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
          at: typeof entry.timestamp === "string" ? entry.timestamp : null,
        };
      }
    }
  }

  return last;
}

/**
 * Resolve a session ID to a JSONL file path.
 *
 * When `cwd` is provided, derives the project directory directly (O(1) lookup).
 * Without cwd, falls back to scanning ~/.claude/projects/ recursively (slow).
 */
export function resolveSessionPath(sessionId: string, cwd?: string): string | null {
  // If already a full path, use it
  if (sessionId.includes("/")) {
    return existsSync(sessionId) ? sessionId : null;
  }

  const projectsDir = join(homedir(), ".claude", "projects");

  // Fast path: derive project dir from cwd
  if (cwd) {
    const directPath = join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(directPath)) return directPath;
    // cwd didn't match — fall through to scan
  }

  // Slow path: recursive scan
  const searchDir = (dir: string): string | null => {
    if (!existsSync(dir)) return null;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = searchDir(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
        return fullPath;
      }
    }
    return null;
  };

  return searchDir(projectsDir);
}
