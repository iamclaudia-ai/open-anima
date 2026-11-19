import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_FOR_FOLDER, resolveClaudeAccount } from "./claude-account";

// A fake `security` (first on PATH) answers for the one account it knows, and a
// fake claude prints what it was launched with, so nothing touches the real
// Keychain or starts a real claude.
let root: string;
let env: Record<string, string>;

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claude-account-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  script(
    join(bin, "security"),
    `[[ "$*" == *"-s anima-claude-account-work"* ]] && { printf 'sk-ant-oat01-fake'; exit 0; }\nexit 44`,
  );
  script(join(bin, "fake-claude"), `echo "token=\${CLAUDE_CODE_OAUTH_TOKEN:-none} args=$*"`);
  mkdirSync(join(root, "work", "repo", "deep"), { recursive: true });
  writeFileSync(join(root, "work", ".claude-account"), "work\n");
  mkdirSync(join(root, "work", "optout"), { recursive: true });
  writeFileSync(join(root, "work", "optout", ".claude-account"), "default\n");
  mkdirSync(join(root, "missing"), { recursive: true });
  writeFileSync(join(root, "missing", ".claude-account"), "nobody\n");
  mkdirSync(join(root, "plain"), { recursive: true });
  env = {
    PATH: `${bin}:/usr/bin:/bin`,
    CLAUDE_BIN: join(bin, "fake-claude"),
    // An inherited token must not leak into a default-account launch.
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-inherited",
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function launch(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([CLAUDE_FOR_FOLDER, ...args], { cwd, env });
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
}

describe("claude-for-folder", () => {
  test("a folder with no marker above it runs on the default login", () => {
    expect(launch(join(root, "plain"), ["--resolve-account"]).out).toBe("default");
    // The inherited token is cleared, so Claude uses its own login.
    expect(launch(join(root, "plain"), ["--resume", "x"]).out).toBe("token=none args=--resume x");
  });

  test("the nearest marker above the folder names the account", () => {
    const deep = join(root, "work", "repo", "deep");
    expect(launch(deep, ["--resolve-account"]).out).toBe("work");
    expect(launch(deep, ["-p", "hi"]).out).toBe("token=sk-ant-oat01-fake args=-p hi");
  });

  test("a nearer `default` marker opts a subfolder back out", () => {
    expect(launch(join(root, "work", "optout"), []).out).toBe("token=none args=");
  });

  test("an account with no Keychain token fails instead of falling back", () => {
    const result = launch(join(root, "missing"), ["--resume", "x"]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain("no token for Claude account 'nobody'");
  });
});

describe("resolveClaudeAccount", () => {
  test("throws with the launcher's message when the token is missing", () => {
    // The real Keychain never has this account; the launcher's error comes through.
    const dir = join(root, "missing-real");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude-account"), "no-such-account-for-tests\n");
    expect(() => resolveClaudeAccount(dir)).toThrow(
      "no token for Claude account 'no-such-account-for-tests'",
    );
  });

  test("returns default for a folder with no marker", () => {
    expect(resolveClaudeAccount(join(root, "plain"))).toBe("default");
  });
});
