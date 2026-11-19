import { describe, expect, it } from "bun:test";
import type { CommandItem } from "../hooks/useCommands";
import { filterCommands } from "./CommandPicker";

const items: CommandItem[] = [
  { name: "browsing-the-web", description: "browse websites", source: "global" },
  { name: "browsing-the-docs", description: "read documentation", source: "global" },
  { name: "testing-in-the-browser", description: "browser tests", source: "global" },
  { name: "summarizing-notes", description: "meeting notes", source: "global" },
  { name: "writing-changelogs", description: "changelog", source: "global" },
  { name: "deploying-the-app", description: "deploy", source: "global" },
];

describe("filterCommands", () => {
  it("returns all items in original order when query is empty", () => {
    const result = filterCommands(items, "");
    expect(result.map((r) => r.item.name)).toEqual(items.map((i) => i.name));
    for (const r of result) expect(r.matchIndices).toEqual([]);
  });

  it("matches all browser-related skills for 'brows' (the user's example)", () => {
    const result = filterCommands(items, "brows");
    const names = result.map((r) => r.item.name);
    expect(names).toContain("browsing-the-web");
    expect(names).toContain("browsing-the-docs");
    expect(names).toContain("testing-in-the-browser");
    // Prefix matches should rank ahead of subsequence matches.
    expect(names.indexOf("browsing-the-web")).toBeLessThan(names.indexOf("testing-in-the-browser"));
  });

  it("returns highlight indices into the matched name", () => {
    const result = filterCommands(items, "brows");
    const browsingTheWeb = result.find((r) => r.item.name === "browsing-the-web")!;
    expect(browsingTheWeb.matchIndices.length).toBeGreaterThan(0);
    // For a prefix match like 'brows' against 'browsing-the-web', the indices
    // should be the first 5 characters.
    expect([...browsingTheWeb.matchIndices].slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("filters out non-matches", () => {
    const result = filterCommands(items, "xyzzy");
    expect(result).toHaveLength(0);
  });

  it("matches subsequence even with non-prefix start", () => {
    // 'notes' should match 'summarizing-notes' (subsequence at the end).
    const result = filterCommands(items, "notes");
    const names = result.map((r) => r.item.name);
    expect(names).toContain("summarizing-notes");
  });
});
