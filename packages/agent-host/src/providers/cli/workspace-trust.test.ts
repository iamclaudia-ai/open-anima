import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { trustWorkspace } from "./workspace-trust";

const ROOT = mkdtempSync(join(tmpdir(), "anima-trust-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;
function configFile(contents?: unknown): string {
  const path = join(ROOT, `claude-${++counter}.json`);
  if (contents !== undefined) writeFileSync(path, JSON.stringify(contents));
  return path;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

describe("trustWorkspace", () => {
  test("marks the folder trusted, keeps everything else, and is idempotent", () => {
    const config = configFile({ numStartups: 3, projects: { "/a": { allowedTools: ["x"] } } });
    expect(trustWorkspace("/a", config)).toBe(true);
    expect(trustWorkspace("/b", config)).toBe(true);
    expect(trustWorkspace("/a", config)).toBe(false);
    const saved = read(config);
    expect(saved.numStartups).toBe(3);
    expect(saved.projects["/a"]).toEqual({ allowedTools: ["x"], hasTrustDialogAccepted: true });
    expect(saved.projects["/b"]).toEqual({ hasTrustDialogAccepted: true });
  });

  test("records the real path, which is what Claude Code looks up", () => {
    const folder = join(ROOT, "real");
    mkdirSync(folder);
    const config = configFile({});
    // tmpdir() is a symlink on macOS (/var → /private/var).
    expect(trustWorkspace(folder, config)).toBe(true);
    expect(read(config).projects[realpathSync(folder)]).toEqual({ hasTrustDialogAccepted: true });
  });

  test("rewrites an entry the user answered No to", () => {
    const config = configFile({ projects: { "/a": { hasTrustDialogAccepted: false } } });
    expect(trustWorkspace("/a", config)).toBe(true);
    expect(read(config).projects["/a"].hasTrustDialogAccepted).toBe(true);
  });

  test("creates the file when there is none", () => {
    const config = configFile();
    expect(trustWorkspace("/a", config)).toBe(true);
    expect(read(config)).toEqual({ projects: { "/a": { hasTrustDialogAccepted: true } } });
  });

  test("leaves the home folder alone: Claude Code never reads its trust from the file", () => {
    const config = configFile({});
    expect(trustWorkspace(homedir(), config)).toBe(false);
    expect(read(config)).toEqual({});
  });
});
