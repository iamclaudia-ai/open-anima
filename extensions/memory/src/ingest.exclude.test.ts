import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { isWorkspaceExcluded, shouldExcludeFile } from "./ingest";

describe("ingest exclude matching", () => {
  const basePath = `${homedir()}/.claude/projects`;
  const scribeFile = `${basePath}/-home-alex-scribe/abcd.jsonl`;
  const appFile = `${basePath}/-home-alex-Projects-acme-app/xyz.jsonl`;

  it("matches relative file-key prefix excludes", () => {
    expect(shouldExcludeFile(scribeFile, basePath, ["-home-alex-scribe/"])).toBe(true);
    expect(shouldExcludeFile(appFile, basePath, ["-home-alex-scribe/"])).toBe(false);
  });

  it("matches absolute excludes", () => {
    expect(shouldExcludeFile(scribeFile, basePath, [`${basePath}/-home-alex-scribe`])).toBe(true);
    expect(shouldExcludeFile(appFile, basePath, [`${basePath}/-home-alex-scribe`])).toBe(false);
  });

  it("matches home-relative absolute excludes", () => {
    expect(shouldExcludeFile(scribeFile, basePath, ["~/.claude/projects/-home-alex-scribe"])).toBe(
      true,
    );
  });
});

describe("workspace exclude matching", () => {
  const basePath = `${homedir()}/.claude/projects`;

  it("excludes a workspace whose project dir matches a relative pattern", () => {
    expect(isWorkspaceExcluded("/home/alex/scribe", basePath, ["-home-alex-scribe/"])).toBe(true);
  });

  it("leaves other workspaces alone, including ones sharing a name prefix", () => {
    const exclude = ["-home-alex-scribe/"];
    expect(isWorkspaceExcluded("/home/alex/Projects/anima", basePath, exclude)).toBe(false);
    expect(isWorkspaceExcluded("/home/alex/scribe-archive", basePath, exclude)).toBe(false);
  });

  it("encodes dots the way Claude Code does", () => {
    expect(
      isWorkspaceExcluded("/home/alex/.anima/work", basePath, ["-home-alex--anima-work/"]),
    ).toBe(true);
  });

  it("matches absolute and home-relative patterns", () => {
    expect(
      isWorkspaceExcluded("/home/alex/scribe", basePath, [`${basePath}/-home-alex-scribe`]),
    ).toBe(true);
    expect(
      isWorkspaceExcluded("/home/alex/scribe", basePath, ["~/.claude/projects/-home-alex-scribe"]),
    ).toBe(true);
  });

  it("excludes nothing when there are no patterns", () => {
    expect(isWorkspaceExcluded("/home/alex/scribe", basePath, [])).toBe(false);
  });
});
