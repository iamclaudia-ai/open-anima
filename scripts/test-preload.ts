/**
 * Test-run isolation: point every module at throwaway config and data folders.
 *
 * Preloaded by `bunfig.toml` before any test file, so this wins over module
 * import order — which is exactly where the previous approach failed. Modules
 * that resolved `~/.anima` at import time could not be redirected by a test
 * setting `HOME` afterwards, so `bun test` wrote into the live agent-host
 * session registry and truncated it to zero. That stranded every running
 * CLI's proxy on a port nothing was listening to, and the orphan reaper then
 * killed the panes as untracked.
 *
 * A test suite must never be able to reach the running system's state, and
 * must pass the same way on a machine with no config at all. This is the floor
 * that guarantees both; individual suites may still set `ANIMA_HOME`,
 * `ANIMA_CONFIG` or `ANIMA_DATA_DIR` per case for their own fixtures.
 */

import { mock } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const { tmpdir } = realOs;

// Drop every Anima variable the shell brought in: an instance's ports, tmux
// prefix, gateway URL and config paths (exported by a second copy's env, or
// by agent-host into every session's pane, with ANIMA_SESSION_ID and the rest:
// packages/agent-host/src/providers/anima-env.ts). Each one overrides a config
// value, so a test would read the instance's settings, or a test gateway
// would bind the instance's port. Only this file's own ANIMA_TEST_* survive.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ANIMA_") && !key.startsWith("ANIMA_TEST_")) {
    delete process.env[key];
  }
}

// The config side: a temp $ANIMA_HOME holding fixture copies of anima.json and
// watchdog.json, both on ports and a tmux prefix no real instance uses. Tests
// never read the user's ~/.anima config (or fail because there is none yet),
// and the watchdog's import-time config read finds its file. Copied fresh on
// every preload, so a test that writes to them (the gateway saves its token
// there) can't leak into the next run.
if (!process.env.ANIMA_TEST_HOME) {
  process.env.ANIMA_TEST_HOME = mkdtempSync(join(tmpdir(), "anima-test-home-"));
}
const fixtures = join(import.meta.dir, "test-fixtures");
const testConfigDir = join(process.env.ANIMA_TEST_HOME, ".anima");
mkdirSync(testConfigDir, { recursive: true });
// Named *.fixture.json: .gitignore ignores every file called anima.json.
copyFileSync(join(fixtures, "anima.fixture.json"), join(testConfigDir, "anima.json"));
copyFileSync(join(fixtures, "watchdog.fixture.json"), join(testConfigDir, "watchdog.json"));
process.env.ANIMA_HOME = process.env.ANIMA_TEST_HOME;
process.env.ANIMA_WATCHDOG_CONFIG = join(testConfigDir, "watchdog.json");

// The user's home folder too: code reaches ~/.claude/projects (transcripts),
// ~/.claude.json (workspace trust), ~/.claude/skills and more through
// os.homedir(). Bun's homedir() reads $HOME once at startup, and a test's
// spyOn(os, "homedir") only replaces the namespace's property, never a
// module's `import { homedir }`. So tests that "moved" HOME still wrote
// transcripts and memory links into the real ~/.claude/projects, thousands of
// folders over time. Here homedir() reads $HOME on every call, as Node's does,
// and $HOME starts at the temp home; a test that sets process.env.HOME gets
// exactly that folder. Spawned children (git, bun) inherit the temp $HOME too.
const testHome = process.env.ANIMA_TEST_HOME;
process.env.HOME = testHome;
const liveHomedir = (): string => process.env.HOME || testHome;
const osWithLiveHome = () => ({
  ...realOs,
  homedir: liveHomedir,
  default: { ...realOs.default, homedir: liveHomedir },
});
mock.module("node:os", osWithLiveHome);
mock.module("os", osWithLiveHome);

if (!process.env.ANIMA_TEST_DATA_DIR) {
  process.env.ANIMA_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "anima-test-data-"));
}
process.env.ANIMA_DATA_DIR = process.env.ANIMA_TEST_DATA_DIR;

// The memory repo too: the memory extension commits, pulls and pushes there,
// and a test run must never touch the real one.
if (!process.env.ANIMA_TEST_MEMORY_DIR) {
  process.env.ANIMA_TEST_MEMORY_DIR = mkdtempSync(join(tmpdir(), "anima-test-memory-"));
}
process.env.ANIMA_MEMORY_DIR = process.env.ANIMA_TEST_MEMORY_DIR;

// Git hooks export GIT_DIR (and in a linked worktree, more of these), and a
// spawned `git` honors them over its cwd. A test that runs `git init` or
// `git commit` in a temp dir would then act on the repository being pushed:
// it once set core.bare = true in the main checkout and committed a fixture
// over a branch from a pre-push hook. Tests only ever mean the temp
// repos they create, so drop every variable that points git somewhere else.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
]) {
  delete process.env[key];
}

// Bun.spawn and Bun.spawnSync without an explicit `env` hand children the
// environment this process STARTED with: neither the deletions above nor the
// ANIMA_DATA_DIR redirect would reach a spawned `git`, `bun` or `anima`.
// (node:child_process does read the live process.env.) Make the live
// process.env the default, so everything a test spawns inherits the
// isolation set up here. An explicit `env` still wins.
type SpawnOptions = { env?: Record<string, string | undefined> };

function withLiveEnv<F extends (...args: never[]) => unknown>(spawn: F): F {
  return ((first: unknown, second?: SpawnOptions) => {
    if (Array.isArray(first)) {
      return spawn(...([first, { ...second, env: second?.env ?? process.env }] as never[]));
    }
    // Object form: Bun.spawn({ cmd, ...options }).
    const options = first as SpawnOptions;
    return spawn(...([{ ...options, env: options.env ?? process.env }] as never[]));
  }) as F;
}

Bun.spawn = withLiveEnv(Bun.spawn);
Bun.spawnSync = withLiveEnv(Bun.spawnSync);
