/**
 * Every SQLite write transaction in a long-lived process runs `BEGIN IMMEDIATE`.
 *
 * bun:sqlite's plain `db.transaction(fn)()` is a deferred `BEGIN`: it takes a read snapshot at its
 * first SELECT and asks for the write lock only at its first write. In WAL mode, if another
 * connection committed in between, that upgrade fails at once with "database is locked", without
 * waiting out `busy_timeout`. With many sessions writing to the shared anima.db, Today's collector
 * (read each key, then write) failed this way several times an hour. `.immediate()` takes the write
 * lock first, so the busy timeout applies. Unit tests run on a private database and never see the
 * race, so this test checks the source instead.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe("SQLite write transactions", () => {
  test("every db.transaction(...) is invoked with .immediate()", async () => {
    const offenders: string[] = [];
    for (const dir of ["extensions", "packages"]) {
      const glob = new Glob(`${dir}/*/{src,mcp}/**/*.ts`);
      for await (const path of glob.scan({ cwd: ROOT })) {
        if (path.endsWith(".test.ts")) continue;
        const text = await Bun.file(join(ROOT, path)).text();
        const transactions = countMatches(text, /\.transaction\(/g);
        if (transactions === 0) continue;
        const immediate = countMatches(text, /\.immediate\(/g);
        if (immediate < transactions) {
          offenders.push(
            `${path}: ${transactions} transaction(s), ${immediate} .immediate() call(s)`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
