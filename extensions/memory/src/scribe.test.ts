import { describe, expect, it } from "bun:test";
import { scribeLogsDir } from "./paths";
import { extractRecoveredScribeResponse, scribeSystemPrompt } from "./scribe";

describe("extractRecoveredScribeResponse", () => {
  it("returns the latest assistant text response", () => {
    const result = extractRecoveredScribeResponse([
      {
        role: "user",
        blocks: [{ type: "text", content: "Process this transcript" }],
      },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", content: "planning" },
          { type: "text", content: "SUMMARY: captured the main points" },
        ],
      },
    ]);

    expect(result).toBe("SUMMARY: captured the main points");
  });

  it("prefers the most recent assistant text block set", () => {
    const result = extractRecoveredScribeResponse([
      {
        role: "assistant",
        blocks: [{ type: "text", content: "older" }],
      },
      {
        role: "assistant",
        blocks: [{ type: "tool_use" }, { type: "text", content: "SKIP: duplicate transcript" }],
      },
    ]);

    expect(result).toBe("SKIP: duplicate transcript");
  });

  it("returns null when there is no assistant text to recover", () => {
    const result = extractRecoveredScribeResponse([
      {
        role: "assistant",
        blocks: [{ type: "tool_use" }],
      },
    ]);

    expect(result).toBeNull();
  });
});

describe("scribeSystemPrompt", () => {
  it("names this instance's memory repo and log folder, never the default paths", () => {
    const previous = process.env.ANIMA_MEMORY_DIR;
    process.env.ANIMA_MEMORY_DIR = "/srv/other-instance/memory";
    try {
      const prompt = scribeSystemPrompt();
      expect(prompt).toContain("/srv/other-instance/memory/episodes/");
      expect(prompt).toContain(scribeLogsDir());
      expect(prompt).not.toContain("~/memory");
      expect(prompt).not.toContain("~/.anima");
      expect(prompt).not.toContain("{{");
    } finally {
      if (previous === undefined) delete process.env.ANIMA_MEMORY_DIR;
      else process.env.ANIMA_MEMORY_DIR = previous;
    }
  });
});
