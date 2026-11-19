import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_MY_PRS } from "./github";

// Runs the real bundled script against a fixture (CPRA_FIXTURE_DIR replaces every gh call).
describe("check-my-prs outside a git checkout", () => {
  let root: string;
  let project: string;
  let fixtures: string;
  let cacheHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-my-prs-"));
    project = join(root, "project");
    fixtures = join(root, "fixtures");
    cacheHome = join(root, "cache");
    mkdirSync(project);
    mkdirSync(fixtures);
    writeFileSync(join(fixtures, "raw.json"), JSON.stringify({ data: { search: { nodes: [] } } }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    return Bun.spawnSync([CHECK_MY_PRS, ...args], {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        XDG_CACHE_HOME: cacheHome,
        // Stop git from finding a repo above the temp folder.
        GIT_CEILING_DIRECTORIES: root,
        ...extraEnv,
      },
    });
  }

  test("still runs with -R, caching in the user's cache folder", () => {
    const result = run(["--json", "--all", "-R", "acme/app"], { CPRA_FIXTURE_DIR: fixtures });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([]);
    expect(existsSync(join(cacheHome, "check-my-prs", "acme_app.json"))).toBe(true);
  });

  test("says what to do without -R instead of a git error", () => {
    const result = run(["--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("is not a git repository; pass -R owner/repo");
  });
});
