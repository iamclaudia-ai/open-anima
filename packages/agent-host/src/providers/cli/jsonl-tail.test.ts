import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionJsonlTail } from "./jsonl-tail";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "anima-tail-")), "session.jsonl");
}

function nextEvent<T = unknown[]>(
  tail: SessionJsonlTail,
  name: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${name}"`)), timeoutMs);
    tail.once(name, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args as T);
    });
  });
}

function appendLine(file: string, obj: unknown): void {
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

describe("SessionJsonlTail", () => {
  test("emits background changes for a Monitor start and its end", async () => {
    const [started, ended] = readFileSync(
      join(import.meta.dir, "fixtures", "background-work.jsonl"),
      "utf8",
    ).split("\n");
    const file = tmpFile();
    writeFileSync(file, "");
    const tail = new SessionJsonlTail("/x", "s", file);
    tail.start();
    await Bun.sleep(40);
    const gotStart = nextEvent<[{ started: unknown[] }, number]>(tail, "background");
    appendFileSync(file, `${started}\n`);
    const [startChanges, startAt] = await gotStart;
    expect(startChanges.started).toEqual([{ id: "b8nzo6c9d" }]);
    expect(startAt).toBe(Date.parse("2026-11-16T18:32:53.324Z"));
    const gotEnd = nextEvent<[{ ended: string[] }]>(tail, "background");
    appendFileSync(file, `${ended}\n`);
    expect((await gotEnd)[0].ended).toEqual(["b8nzo6c9d"]);
    tail.stop();
  });

  test("emits api_error with the entry's fields and timestamp", async () => {
    const file = tmpFile();
    writeFileSync(file, "");
    const tail = new SessionJsonlTail("/x", "s", file);
    const got = nextEvent<[Record<string, unknown>, string | undefined]>(tail, "api_error");
    tail.start();
    await Bun.sleep(40);
    appendFileSync(
      file,
      readFileSync(join(import.meta.dir, "fixtures", "api-error-entry.jsonl"), "utf8"),
    );
    const [info, timestamp] = await got;
    expect(info).toEqual({
      error: "server_error",
      apiError: "connection_failed",
      streamCutCause: "stale_connection",
      text: "API Error: Connection lost mid-response. The response above may be incomplete.",
    });
    expect(timestamp).toBe("2026-11-03T22:41:08.408Z");
    tail.stop();
  });

  test("an API error already in the transcript at start never fires", async () => {
    const file = tmpFile();
    writeFileSync(
      file,
      readFileSync(join(import.meta.dir, "fixtures", "api-error-entry.jsonl"), "utf8"),
    );
    const tail = new SessionJsonlTail("/x", "s", file);
    let fired = false;
    tail.on("api_error", () => {
      fired = true;
    });
    tail.start();
    await Bun.sleep(400);
    expect(fired).toBe(false);
    tail.stop();
  });

  test("emits interrupt on a marker appended after start", async () => {
    const file = tmpFile();
    writeFileSync(file, "");
    const tail = new SessionJsonlTail("/x", "s", file);
    const got = nextEvent<[boolean]>(tail, "interrupt");
    tail.start();
    await Bun.sleep(40);
    appendLine(file, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
      interruptedMessageId: "msg_1",
    });
    const [forToolUse] = await got;
    expect(forToolUse).toBe(true);
    tail.stop();
  });

  test("skips pre-existing history (seeks to EOF)", async () => {
    const file = tmpFile();
    appendLine(file, { type: "user", message: { role: "user", content: "old" } });
    const tail = new SessionJsonlTail("/x", "s", file);
    let sawOld = false;
    tail.on("user_prompt", (t: string) => {
      if (t === "old") sawOld = true;
    });
    const got = nextEvent<[string]>(tail, "user_prompt");
    tail.start();
    await Bun.sleep(40);
    appendLine(file, { type: "user", message: { role: "user", content: "new" } });
    const [text] = await got;
    expect(text).toBe("new");
    expect(sawOld).toBe(false);
    tail.stop();
  });

  test("emits enqueue then dequeue for a steer", async () => {
    const file = tmpFile();
    writeFileSync(file, "");
    const tail = new SessionJsonlTail("/x", "s", file);
    const enq = nextEvent<[string]>(tail, "enqueue");
    const deq = nextEvent(tail, "dequeue");
    tail.start();
    await Bun.sleep(30);
    appendLine(file, { type: "queue-operation", operation: "enqueue", content: "steer" });
    appendLine(file, { type: "queue-operation", operation: "dequeue" });
    const [content] = await enq;
    expect(content).toBe("steer");
    await deq;
    tail.stop();
  });

  test("handles a file that appears after start()", async () => {
    const file = tmpFile();
    // do NOT create the file yet
    const tail = new SessionJsonlTail("/x", "s", file);
    const got = nextEvent<[string]>(tail, "user_prompt");
    tail.start();
    await Bun.sleep(40);
    writeFileSync(file, "");
    await Bun.sleep(40);
    appendLine(file, { type: "user", message: { role: "user", content: "late" } });
    const [text] = await got;
    expect(text).toBe("late");
    tail.stop();
  });

  test("historyLines returns the complete lines before where tailing began", () => {
    const file = tmpFile();
    writeFileSync(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`);
    const tail = new SessionJsonlTail("/x", "s", file);
    tail.start();
    appendLine(file, { n: 3 }); // after the start offset: the tail's, not history's
    expect(tail.historyLines().filter(Boolean)).toEqual(['{"n":1}', '{"n":2}']);
    // Reading back less than the whole file drops the leading fragment.
    expect(tail.historyLines(10).filter(Boolean)).toEqual(['{"n":2}']);
    tail.stop();
  });

  test("historyLines is empty when the transcript didn't exist at start", () => {
    const tail = new SessionJsonlTail("/x", "s", tmpFile());
    tail.start();
    expect(tail.historyLines()).toEqual([]);
    tail.stop();
  });
});
