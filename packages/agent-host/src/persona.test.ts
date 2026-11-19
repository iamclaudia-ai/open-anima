import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA, SHIPPED_PERSONAS_DIR, resolvePersonaFile } from "./persona";

describe("resolvePersonaFile", () => {
  let dir: string;
  let configHome: string;
  let shippedDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persona-test-"));
    configHome = join(dir, "home");
    shippedDir = join(dir, "shipped");
    mkdirSync(join(configHome, ".anima", "personas"), { recursive: true });
    mkdirSync(shippedDir, { recursive: true });
    writeFileSync(join(shippedDir, "lumen.md"), "shipped lumen");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to the shipped lumen persona", () => {
    expect(resolvePersonaFile(undefined, { configHome, shippedDir })).toBe(
      join(shippedDir, "lumen.md"),
    );
  });

  it("prefers the user's own persona over the shipped one", () => {
    const own = join(configHome, ".anima", "personas", "lumen.md");
    writeFileSync(own, "my lumen");
    expect(resolvePersonaFile("lumen", { configHome, shippedDir })).toBe(own);
  });

  it("uses a path as given", () => {
    const path = join(dir, "custom.md");
    writeFileSync(path, "custom");
    expect(resolvePersonaFile(path, { configHome, shippedDir })).toBe(path);
  });

  it("returns undefined for none, empty, or a persona that doesn't exist", () => {
    expect(resolvePersonaFile("none", { configHome, shippedDir })).toBeUndefined();
    expect(resolvePersonaFile("  ", { configHome, shippedDir })).toBeUndefined();
    expect(resolvePersonaFile("nobody", { configHome, shippedDir })).toBeUndefined();
    expect(resolvePersonaFile(join(dir, "missing.md"), { configHome, shippedDir })).toBeUndefined();
  });

  it("ships the default persona in the repo", () => {
    expect(existsSync(join(SHIPPED_PERSONAS_DIR, `${DEFAULT_PERSONA}.md`))).toBe(true);
  });
});
