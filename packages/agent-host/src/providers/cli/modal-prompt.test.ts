import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectModalPrompt } from "./modal-prompt";

/**
 * Both modal fixtures are verbatim `tmux capture-pane -p` output from a live
 * `claude` TUI (v2.1.233), reproduced by running the exact
 * command in a throwaway repo. Transcribing them by hand would defeat
 * the purpose — the whitespace, the `❯` marker, and the blank line before the
 * footer are the things the parser keys on.
 */

/** Hook-driven approval: a command-guard hook returning `permissionDecision: "ask"`. */
const HOOK_MODAL = [
  "⏺ Bash(git branch -f probe HEAD)",
  "  ⎿  Waiting…",
  "",
  "────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   git branch -f probe HEAD",
  "   Create or force branch 'probe' to point to HEAD",
  "",
  " Hook PreToolUse:Bash requires confirmation for this command:",
  " DCG warn: git branch -D/--force deletes branches without checks. Recoverable via 'git reflog'. [settings]",
  " settings.json to update hooks",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
  "",
  "",
].join("\n");

/** Folder-trust dialog — the "future modal we can't enumerate" case, today. */
const TRUST_MODAL = [
  "",
  "────────────────────────────────────────────────────────────────",
  " Accessing workspace:",
  "",
  " /tmp/example/claude/scratchpad/modal-probe",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to cancel",
  "",
  "",
].join("\n");

/** An ordinary idle pane — input box, status line, no modal. */
const IDLE_PANE = [
  "⏺ Done — all three tests pass.",
  "",
  "✻ Brewed for 5s",
  "────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────",
  "  [Opus 5 (1M context)] Read: 64845 In: 2 Total: 565155 Context: 56%",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  "",
].join("\n");

describe("detectModalPrompt — hook approval", () => {
  const modal = detectModalPrompt(HOOK_MODAL);

  test("detects the prompt and classifies it as an approval", () => {
    expect(modal).not.toBeNull();
    expect(modal?.kind).toBe("approval");
  });

  test("takes the question from the line that asks", () => {
    expect(modal?.question).toBe("Do you want to proceed?");
  });

  test("carries the command and the hook's reason as context", () => {
    expect(modal?.context).toContain("git branch -f probe HEAD");
    expect(modal?.context.join("\n")).toContain("DCG warn: git branch -D/--force");
    // Stops at the rule — the transcript above the modal is not part of it.
    expect(modal?.context.join("\n")).not.toContain("Waiting…");
  });

  test("parses both options with the selection marker", () => {
    expect(modal?.options).toEqual([
      { key: "1", label: "Yes", selected: true },
      { key: "2", label: "No", selected: false },
    ]);
  });
});

describe("detectModalPrompt — trust dialog", () => {
  const modal = detectModalPrompt(TRUST_MODAL);

  test("detects a modal whose footer is `Enter to confirm`", () => {
    expect(modal?.options.map((o) => o.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
  });

  test("headlines the real question, not the line above the options", () => {
    // "Security guide" is what sits directly above the options.
    expect(modal?.question).toContain("Is this a project you created or one you trust?");
  });

  test("is input, not approval — nothing is being authorized", () => {
    expect(modal?.kind).toBe("input");
  });
});

describe("detectModalPrompt — negatives", () => {
  test("an idle pane is not a prompt", () => {
    expect(detectModalPrompt(IDLE_PANE)).toBeNull();
  });

  test("an empty pane is not a prompt", () => {
    expect(detectModalPrompt("")).toBeNull();
  });

  test("a numbered list in the transcript is not a prompt", () => {
    const pane = [
      "⏺ Three things to try:",
      "  1. Restart the gateway",
      "  2. Check the proxy port",
      "  3. Re-run the migration",
      "",
      "────────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(detectModalPrompt(pane)).toBeNull();
  });

  test("a modal footer with no options above it is not a prompt", () => {
    expect(detectModalPrompt(["  Some text", "", " Esc to cancel · Tab to amend"].join("\n"))).toBe(
      null,
    );
  });

  test("options that don't number from 1 are not a prompt", () => {
    const pane = [" Pick one", " 2. Second", " 3. Third", "", " Esc to cancel · Tab to amend"].join(
      "\n",
    );
    expect(detectModalPrompt(pane)).toBeNull();
  });

  test("a lone option is not a prompt", () => {
    const pane = [" Heads up", " 1. Okay", "", " Esc to cancel"].join("\n");
    expect(detectModalPrompt(pane)).toBeNull();
  });

  test("a footer scrolled up the pane is not a prompt", () => {
    const pane = [
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      " Esc to cancel · Tab to amend",
      "⏺ …and then the turn carried on for several more lines",
      "  ⎿  Read 40 lines",
      "✻ Cogitated for 12s",
      "  more output here",
      "  and yet more",
    ].join("\n");
    expect(detectModalPrompt(pane)).toBeNull();
  });
});

describe("fingerprint", () => {
  test("is stable across polls of the same modal", () => {
    expect(detectModalPrompt(HOOK_MODAL)?.fingerprint).toBe(
      detectModalPrompt(HOOK_MODAL)?.fingerprint,
    );
  });

  test("does not move when the selection does", () => {
    const moved = HOOK_MODAL.replace(" ❯ 1. Yes", "   1. Yes").replace("   2. No", " ❯ 2. No");
    const before = detectModalPrompt(HOOK_MODAL);
    const after = detectModalPrompt(moved);
    expect(after?.options[1]?.selected).toBe(true);
    expect(after?.fingerprint).toBe(before!.fingerprint);
  });

  test("differs between different modals", () => {
    expect(detectModalPrompt(HOOK_MODAL)?.fingerprint).not.toBe(
      detectModalPrompt(TRUST_MODAL)?.fingerprint,
    );
  });

  test("differs when the same question is asked about a different command", () => {
    const other = HOOK_MODAL.replace(/git branch -f probe HEAD/g, "git push --force origin main");
    expect(detectModalPrompt(other)?.fingerprint).not.toBe(
      detectModalPrompt(HOOK_MODAL)?.fingerprint,
    );
  });
});

/**
 * Permission prompt with Claude Code's auto-deny countdown, verbatim
 * `capture-pane -p` output from Claude Code 2.1.322: a detached
 * pane running `bash -c "touch probe.txt; rm probe.txt"`, captured at Anima's
 * 220 columns (1:34 left) and again after `resize-window -x 90` (1:32 left),
 * which is what attaching from a smaller terminal does. The first fix was
 * built on a guessed "deny" wording; the CLI says "block".
 */
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const WIDE = fixture("modal-countdown-220.txt");
const NARROW = fixture("modal-countdown-90.txt");

describe("auto-deny countdown", () => {
  test("detects both captures as approvals", () => {
    expect(detectModalPrompt(WIDE)?.kind).toBe("approval");
    expect(detectModalPrompt(NARROW)?.kind).toBe("approval");
  });

  test("the ticking clock does not change the fingerprint", () => {
    const early = detectModalPrompt(WIDE);
    const lastSeconds = detectModalPrompt(WIDE.replace("in 1:34,", "in 0:05,"));
    expect(early).not.toBeNull();
    expect(lastSeconds?.fingerprint).toBe(early!.fingerprint);
  });

  test("re-wrapping at another pane width does not change the fingerprint", () => {
    expect(detectModalPrompt(NARROW)?.fingerprint).toBe(detectModalPrompt(WIDE)?.fingerprint);
  });

  test("still tells apart prompts about different commands", () => {
    const other = WIDE.replace(/probe\.txt/g, "other.txt");
    expect(detectModalPrompt(other)?.fingerprint).not.toBe(detectModalPrompt(WIDE)?.fingerprint);
  });

  test("parses the time left in seconds, wrapped or not", () => {
    expect(detectModalPrompt(WIDE)?.autoDenySec).toBe(94);
    expect(detectModalPrompt(NARROW)?.autoDenySec).toBe(92);
  });

  test("parses it when the wrap falls between the words and the clock", () => {
    const pane = WIDE.replace("this request in 1:34,", "this request in\n 1:34,");
    expect(detectModalPrompt(pane)?.autoDenySec).toBe(94);
  });

  test("keeps the countdown in the context, where the card shows it", () => {
    expect(detectModalPrompt(WIDE)?.context.join("\n")).toContain(
      "automatically block this request in 1:34",
    );
  });

  test("is absent on a prompt without one", () => {
    expect(detectModalPrompt(HOOK_MODAL)?.autoDenySec).toBeUndefined();
  });
});
