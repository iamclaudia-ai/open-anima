/**
 * Tails our own session's Claude Code JSONL transcript and emits the runtime
 * signals that never reach the SSE wire (see ./jsonl). One file, polled from
 * EOF, so we react only to NEW activity:
 *   - "user_prompt"(text) / "enqueue"(content) — a prompt landed (receipt)
 *   - "dequeue" / "remove"                     — steer handling (new turn / in-turn)
 *   - "interrupt"(forToolUse)                  — Escape landed; the turn was aborted
 * - "api_error"(info, timestamp) — the CLI gave up on an API failure
 *   - "background"(changes, atMs)              — background work started or ended
 *
 * Polling (not fs.watch) is deliberate: fs.watch on macOS is flaky for rapidly
 * appended files, and a ~150ms poll is ample for these human-scale signals. The
 * tail is best-effort — transient read errors are simply retried next tick.
 */

import { EventEmitter } from "node:events";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { backgroundChanges } from "./background-work";
import { classifyRecord, parseEntry, resolveOwnSessionPath } from "./jsonl";

const POLL_MS = 150;
/** How much transcript `historyLines()` reads back from the start offset. */
const HISTORY_BYTES = 1024 * 1024;

export class SessionJsonlTail extends EventEmitter {
  private readonly cwd: string;
  private readonly sessionId: string;
  /** Explicit path override (tests); otherwise resolved from cwd + sessionId. */
  private readonly pathOverride?: string;

  private path = "";
  private offset = 0;
  /** Where tailing began: everything before it is history. */
  private startOffset = 0;
  private carry = "";
  private decoder = new StringDecoder("utf8");
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;

  constructor(cwd: string, sessionId: string, pathOverride?: string) {
    super();
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.pathOverride = pathOverride;
  }

  /** Begin tailing. Seeks to EOF when the file already exists, skipping history. */
  start(): void {
    if (this.timer) return;
    this.path = this.resolvePath();
    this.offset = this.path && existsSync(this.path) ? statSync(this.path).size : 0;
    this.startOffset = this.offset;
    this.carry = "";
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The complete lines in the last `maxBytes` before where tailing began,
   * oldest first. The tail reads from that same offset, so nothing is seen by
   * both. Transcripts run to hundreds of MB, hence reading from the end.
   */
  historyLines(maxBytes = HISTORY_BYTES): string[] {
    const end = this.startOffset;
    if (!this.path || end === 0) return [];
    const from = Math.max(0, end - maxBytes);
    const buf = Buffer.alloc(end - from);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    // Starting mid-file lands mid-line: the first piece is a fragment.
    if (from > 0) lines.shift();
    return lines;
  }

  private resolvePath(): string {
    return this.pathOverride ?? resolveOwnSessionPath(this.cwd, this.sessionId);
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      if (!this.path || !existsSync(this.path)) {
        const p = this.resolvePath();
        if (!existsSync(p)) return;
        this.path = p;
        this.offset = 0; // file just appeared — read from the top
        this.carry = "";
      }
      const size = statSync(this.path).size;
      if (size < this.offset) {
        // Truncated/rotated (same pane, new session) — restart from the top.
        this.offset = 0;
        this.carry = "";
      }
      if (size === this.offset) return;
      const bytes = await Bun.file(this.path).slice(this.offset, size).arrayBuffer();
      this.offset = size;
      // StringDecoder carries partial multibyte sequences across reads.
      this.carry += this.decoder.write(Buffer.from(bytes));
      let nl: number;
      while ((nl = this.carry.indexOf("\n")) >= 0) {
        const line = this.carry.slice(0, nl);
        this.carry = this.carry.slice(nl + 1);
        this.dispatch(line);
      }
    } catch {
      // best-effort tail; transient read errors are retried next tick
    } finally {
      this.reading = false;
    }
  }

  private dispatch(line: string): void {
    const record = parseEntry(line);
    if (!record) return;
    const background = backgroundChanges(record);
    if (background.started.length > 0 || background.ended.length > 0) {
      this.emit("background", background, entryTime(record));
    }
    const entry = classifyRecord(record);
    switch (entry.kind) {
      case "user_prompt":
        this.emit("user_prompt", entry.text);
        break;
      case "enqueue":
        this.emit("enqueue", entry.content);
        break;
      case "dequeue":
        this.emit("dequeue");
        break;
      case "remove":
        this.emit("remove");
        break;
      case "interrupt":
        this.emit("interrupt", entry.forToolUse);
        break;
      case "api_error": {
        const { kind: _kind, timestamp, ...info } = entry;
        this.emit("api_error", info, timestamp);
        break;
      }
      default:
        break;
    }
  }
}

/** When an entry was written (ms); now when it carries no usable timestamp. */
export function entryTime(record: Record<string, unknown>): number {
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(at) ? at : Date.now();
}
