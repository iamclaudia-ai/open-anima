import { describe, expect, it } from "bun:test";
import { tmuxAttachCommand } from "./SessionMenu";

describe("tmuxAttachCommand", () => {
  it("names the pane with the instance's tmux prefix", () => {
    expect(tmuxAttachCommand("abc", "open-anima")).toBe("tmux attach -t open-anima-claude-abc");
  });

  it("falls back to the default prefix when the instance didn't say", () => {
    expect(tmuxAttachCommand("abc")).toBe("tmux attach -t anima-claude-abc");
    expect(tmuxAttachCommand("abc", undefined)).toBe("tmux attach -t anima-claude-abc");
  });
});
