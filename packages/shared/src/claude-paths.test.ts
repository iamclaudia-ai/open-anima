import { describe, expect, test } from "bun:test";
import { claudeProjectSlug } from "./claude-paths";

describe("claudeProjectSlug", () => {
  test("matches Claude Code's folder naming", () => {
    expect(claudeProjectSlug("/home/alex/projects/anima")).toBe("-home-alex-projects-anima");
    expect(claudeProjectSlug("/home/me/.config")).toBe("-home-me--config");
    expect(claudeProjectSlug("/home/me/app.worktrees/alex/fix")).toBe(
      "-home-me-app-worktrees-alex-fix",
    );
  });

  test("replaces every character but letters and digits (verified with a probe folder)", () => {
    expect(claudeProjectSlug("/a/tmp/slug_probe dir+x")).toBe("-a-tmp-slug-probe-dir-x");
  });
});
