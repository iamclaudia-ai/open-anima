import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHookSettings } from "./hook-settings";

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

function written(permission: boolean): {
  path: string;
  backgroundDir: string;
  hooks: Record<string, HookEntry[]>;
} {
  const dir = mkdtempSync(join(tmpdir(), "anima-hook-settings-"));
  const backgroundDir = join(dir, "background");
  const path = writeHookSettings({
    permission,
    backgroundDir,
    dir,
    bun: "/opt/bun",
    binDir: "/repo/bin",
  });
  const { hooks } = JSON.parse(readFileSync(path, "utf8")) as {
    hooks: Record<string, HookEntry[]>;
  };
  return { path, backgroundDir, hooks };
}

describe("writeHookSettings", () => {
  test("every launch gets the Stop hook, pointed at the snapshot folder", () => {
    const { path, backgroundDir, hooks } = written(false);
    expect(path.endsWith("hook-settings.json")).toBe(true);
    expect(Object.keys(hooks)).toEqual(["Stop"]);
    const stop = hooks.Stop![0]!.hooks[0]!;
    expect(stop.command).toBe(`'/opt/bun' '/repo/bin/stop-hook.ts' '${backgroundDir}'`);
    expect(stop.timeout).toBeLessThanOrEqual(10);
    expect(existsSync(backgroundDir)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the PermissionRequest hook comes only with a gateway token", () => {
    const { hooks } = written(true);
    expect(Object.keys(hooks).sort()).toEqual(["PermissionRequest", "Stop"]);
    expect(hooks.PermissionRequest![0]!.matcher).toBe("*");
    expect(hooks.PermissionRequest![0]!.hooks[0]!.command).toBe(
      "'/opt/bun' '/repo/bin/permission-hook.ts'",
    );
  });
});
