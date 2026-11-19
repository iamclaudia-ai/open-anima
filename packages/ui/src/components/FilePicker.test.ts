import { describe, expect, it } from "bun:test";
import { filterFiles } from "./FilePicker";

const files = [
  "packages/ui/src/components/InputArea.tsx",
  "packages/ui/src/components/CommandPicker.tsx",
  "packages/ui/src/hooks/useFiles.ts",
  "packages/shared/index.ts",
  "clients/plugin/src/extension.ts",
  "clients/Desktop/App.swift",
  "docs/My Notes.md",
  "README.md",
  "package.json",
];

const paths = (query: string) => filterFiles(files, query).map((r) => r.path);

describe("filterFiles", () => {
  it("lists the root's entries for an empty query, directories first", () => {
    expect(paths("")).toEqual(["clients/", "docs/", "packages/", "package.json", "README.md"]);
  });

  it("matches entries that start with the typed name", () => {
    expect(paths("pa")).toEqual(["packages/", "package.json"]);
  });

  it("lists a directory's contents once it ends in a slash", () => {
    expect(paths("packages/")).toEqual(["packages/shared/", "packages/ui/"]);
    expect(paths("packages/ui/src/hooks/")).toEqual(["packages/ui/src/hooks/useFiles.ts"]);
  });

  it("narrows within a directory", () => {
    expect(paths("packages/ui/src/components/In")).toEqual([
      "packages/ui/src/components/InputArea.tsx",
    ]);
  });

  it("ignores case but inserts the path's real casing", () => {
    expect(paths("CLIENTS/desk")).toEqual(["clients/Desktop/"]);
    expect(paths("readme")).toEqual(["README.md"]);
  });

  it("highlights the typed prefix", () => {
    expect(filterFiles(files, "pa")[0].matchIndices).toEqual([0, 1]);
  });

  it("does not fuzzy match: a name deeper in the tree needs its path", () => {
    expect(paths("InputArea")).toEqual([]);
  });

  it("matches nothing for words that aren't a path, so the picker closes", () => {
    expect(paths("mention")).toEqual([]);
    expect(paths("p and then a whole sentence")).toEqual([]);
  });

  it("completes a path with a space in it", () => {
    expect(paths("docs/My N")).toEqual(["docs/My Notes.md"]);
  });

  it("accepts a leading ./", () => {
    expect(paths("./cl")).toEqual(["clients/"]);
  });
});
