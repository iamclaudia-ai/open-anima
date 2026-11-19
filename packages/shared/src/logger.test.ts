import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, flushLogs } from "./logger";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("flushLogs", () => {
  test("every line logged before it is on disk when it resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anima-logger-"));
    dirs.push(dir);
    const file = join(dir, "test.log");
    const log = createLogger("FlushTest", file);
    for (let i = 0; i < 50; i++) log.info(`line ${i}`);
    log.warn("the last line before exit", { cut: ["abc12345"] });

    await flushLogs();

    const text = readFileSync(file, "utf-8");
    expect(text).toContain("line 0");
    expect(text).toContain("line 49");
    expect(text).toContain('the last line before exit {"cut":["abc12345"]}');
  });

  test("returns at once when nothing is buffered", async () => {
    const t0 = Date.now();
    await flushLogs();
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
