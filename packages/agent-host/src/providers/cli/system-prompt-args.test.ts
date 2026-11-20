import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemPromptArgs } from "./system-prompt-args";

const dir = mkdtempSync(join(tmpdir(), "anima-system-prompt-"));
const personaFile = join(dir, "persona.md");
writeFileSync(personaFile, "You are Ada.\n\n");

function args(input: { persona?: boolean; mode?: "append" | "replace"; context?: string }) {
  const merged: string[] = [];
  const result = systemPromptArgs({
    personaFile: input.persona ? personaFile : undefined,
    mode: input.mode,
    context: input.context,
    writeMerged: (text) => {
      merged.push(text);
      const path = join(dir, `merged-${merged.length}.md`);
      writeFileSync(path, text);
      return path;
    },
  });
  return { result, merged };
}

function appendFlags(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith("--append-system-prompt"));
}

describe("systemPromptArgs", () => {
  // Older Claude Code exits on launch when both append flags are present.
  test("append mode with persona and context passes one merged file", () => {
    const { result, merged } = args({
      persona: true,
      mode: "append",
      context: " Today is Friday. ",
    });
    expect(appendFlags(result)).toEqual(["--append-system-prompt-file"]);
    expect(readFileSync(result[1]!, "utf8")).toBe("You are Ada.\n\nToday is Friday.\n");
    expect(merged).toHaveLength(1);
  });

  test("an unset mode appends like append mode", () => {
    const { result } = args({ persona: true, context: "ctx" });
    expect(appendFlags(result)).toEqual(["--append-system-prompt-file"]);
  });

  test("append mode with no context passes the persona file itself", () => {
    const { result, merged } = args({ persona: true, mode: "append", context: "   " });
    expect(result).toEqual(["--append-system-prompt-file", personaFile]);
    expect(merged).toHaveLength(0);
  });

  test("replace mode swaps the system prompt and appends the context", () => {
    const { result, merged } = args({ persona: true, mode: "replace", context: "ctx" });
    expect(result).toEqual(["--system-prompt-file", personaFile, "--append-system-prompt", "ctx"]);
    expect(merged).toHaveLength(0);
  });

  test("no persona appends the context alone", () => {
    expect(args({ context: "ctx" }).result).toEqual(["--append-system-prompt", "ctx"]);
    expect(args({}).result).toEqual([]);
  });
});
