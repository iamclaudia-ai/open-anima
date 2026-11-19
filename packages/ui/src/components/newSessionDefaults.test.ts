import { describe, expect, it } from "bun:test";
import type { WorkspaceInfo } from "../hooks/useChatGateway";
import { branchFromTitle, defaultWorkspace, matchWorkspaces } from "./newSessionDefaults";

const ws = (id: string, updatedAt: string, pinned = false): WorkspaceInfo => ({
  id,
  name: id,
  cwd: `/p/${id}`,
  cwdDisplay: `~/p/${id}`,
  general: false,
  pinned,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt,
});

describe("defaultWorkspace", () => {
  const list = [
    ws("pinned-old", "2026-10-01T00:00:00Z", true),
    ws("recent", "2026-11-05T09:00:00Z"),
    ws("older", "2026-11-04T09:00:00Z"),
  ];

  it("prefers the workspace being viewed", () => {
    expect(defaultWorkspace(list, "older")?.id).toBe("older");
  });

  it("falls back to the latest activity, ignoring pins", () => {
    expect(defaultWorkspace(list, null)?.id).toBe("recent");
    expect(defaultWorkspace(list, "gone")?.id).toBe("recent");
  });

  it("is null for no workspaces", () => {
    expect(defaultWorkspace([], null)).toBeNull();
  });
});

describe("branchFromTitle", () => {
  it("slugs a title", () => {
    expect(branchFromTitle("Fix the iOS login bug!")).toBe("fix-the-ios-login-bug");
  });

  it("keeps slashes and dots a branch may have", () => {
    expect(branchFromTitle("feat/new session v2.1")).toBe("feat/new-session-v2.1");
  });

  it("drops what validateWorktreeBranch refuses", () => {
    expect(branchFromTitle("--../.hidden//x.")).toBe("hidden/x");
    expect(branchFromTitle("/leading and trailing/")).toBe("leading-and-trailing");
    expect(branchFromTitle("🌟✨")).toBe("");
  });

  it("caps the length", () => {
    expect(branchFromTitle("a".repeat(100)).length).toBe(60);
  });
});

describe("matchWorkspaces", () => {
  const list = ["web", "store-mobile", "store", "anima", "frameworks"].map((id) =>
    ws(id, "2026-11-05T00:00:00Z"),
  );
  const names = (q: string) => matchWorkspaces(list, q).map((w) => w.id);

  it("returns everything, in order, for an empty query", () => {
    expect(names("  ")).toEqual(["web", "store-mobile", "store", "anima", "frameworks"]);
  });

  it("ranks a name prefix before a word start before a substring", () => {
    expect(names("sto")).toEqual(["store-mobile", "store"]);
    expect(names("mob")).toEqual(["store-mobile"]);
    expect(names("wor")).toEqual(["frameworks"]);
    expect(names("an")).toEqual(["anima"]);
  });

  it("matches the folder path, then letters in order", () => {
    expect(names("~/p/fra")).toEqual(["frameworks"]);
    expect(names("stm")).toEqual(["store-mobile"]);
  });

  it("is case-insensitive and drops non-matches", () => {
    expect(names("WEB")).toEqual(["web"]);
    expect(names("zzz")).toEqual([]);
  });
});
