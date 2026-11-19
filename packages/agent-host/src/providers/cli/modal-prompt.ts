/**
 * Modal-prompt detection for the Claude CLI runtime.
 *
 * The CLI sometimes stops on a full-screen modal — a hook returning
 * `permissionDecision: "ask"`, the folder-trust dialog, a re-auth prompt — and
 * waits for a keypress. From outside the pane that is indistinguishable from a
 * hung session: no SSE, no JSONL entry, nothing. This parses `capture-pane`
 * output into a structured prompt so the runtime can surface it and answer it.
 *
 * Both fixtures in `modal-prompt.test.ts` are verbatim `capture-pane` output
 * from a live CLI, not transcriptions. They share one shape:
 *
 *   ──────────────────────────────  ← rule where the input box would be
 *    Bash command                    ← context: title, command, hook reason
 *    Hook PreToolUse:Bash requires confirmation for this command:
 *    Do you want to proceed?         ← question
 *    ❯ 1. Yes                        ← options, `❯` marks the selection
 *      2. No
 *    Esc to cancel · Tab to amend    ← footer
 *
 * Detection is deliberately anchored on the **footer**, not the question. The
 * question text varies per modal (and future modals will invent their own), but
 * every one of them ends with an `Esc to cancel` / `Enter to confirm` footer at
 * the bottom of the pane — which ordinary transcript scrollback never renders.
 * That anchor plus "a numbered option block sits directly above it" is what
 * keeps a numbered list in the conversation from reading as a prompt, the same
 * discipline `isFeedbackSurvey` uses for its options row.
 */

export type ModalKind = "approval" | "input";

export interface ModalOption {
  /** Key to press to choose this option — the number exactly as rendered. */
  key: string;
  label: string;
  /** True for the option the TUI currently has under `❯`. */
  selected: boolean;
}

export interface ModalPrompt {
  /**
   * `approval` for "may I do this?" (hook confirmations, permission prompts) —
   * these map to `awaiting_approval`. Everything else is `awaiting_input`.
   */
  kind: ModalKind;
  /**
   * Headline for the prompt, derived from {@link context} rather than being
   * removed from it. The trust dialog is why: its actual question is five lines
   * above the options, with body text in between, so "the line directly above
   * the options" would headline a modal about trusting a folder with
   * "Security guide".
   */
  question: string;
  /** The whole modal body, in reading order: title, command, reason, question. */
  context: string[];
  options: ModalOption[];
  footer: string;
  /**
   * Seconds left before the CLI denies the prompt on its own, as rendered at
   * capture time. Claude Code adds this countdown to permission prompts on a
   * session nobody is attached to; absent when the modal has none.
   */
  autoDenySec?: number;
  /**
   * Stable identity for this modal. Detection runs on a poll, so the same
   * prompt is seen many times; the fingerprint is what makes "still the same
   * modal" cheap to answer and keeps us from re-announcing it every tick.
   */
  fingerprint: string;
}

/** Footer line every modal renders, and nothing else does. */
const FOOTER_RE = /(?:Esc to cancel|Enter to confirm|Enter to select)/;
/** `❯ 1. Yes` / `  2. No` — selection marker optional. */
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(\S.*?)\s*$/;
/** The horizontal rule the TUI draws where the input box would be. */
const RULE_RE = /^\s*[─━-]{10,}\s*$/;
/** How far from the bottom of the pane the footer may sit. */
const FOOTER_SEARCH_LINES = 4;
/** Cap on context lines carried into the event — enough for the hook reason. */
const MAX_CONTEXT_LINES = 12;
/** A prompt with fewer options than this is not a prompt. */
const MIN_OPTIONS = 2;

/**
 * The auto-deny countdown: "⚠ Claude Code will automatically block this request
 * in 1:39, to avoid holding up an unattended session" (Claude Code 2.1.322).
 * The verb is a wildcard because it has already changed once: an earlier fix
 * matched "deny" and the CLI says "block". Matched against the body joined
 * into one string, since a narrow pane wraps the sentence. Captures minutes
 * and seconds.
 */
const AUTO_DENY_RE = /automatically \w+ this request in\s+(\d+):(\d{2})/i;

function parseAutoDeny(context: string[]): number | undefined {
  const m = AUTO_DENY_RE.exec(context.join(" "));
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** {@link AUTO_DENY_RE} for {@link stableBody}'s whitespace-free text. */
const COMPACT_AUTO_DENY_RE = /(automatically\w+thisrequestin)\d+:\d{2}/gi;

/**
 * The body as fingerprint input, independent of everything that changes while
 * the same prompt sits on screen:
 *
 * - **The countdown** ticks every second. Hashing it made one prompt look new
 *   on every poll: a fresh card each tick, and every answer refused as
 *   "the prompt has changed".
 * - **The pane width** changes when someone attaches with a different-sized
 *   terminal, which re-wraps the command and redraws the `╌` rules at the new
 *   width. Whitespace, the `│` gutter and rule characters are dropped, so the
 *   same text hashes the same however it wraps. The full body is used, not
 *   the capped {@link ModalPrompt.context}, because a narrower pane needs more
 *   lines and the cap would cut it at a different place.
 */
function stableBody(body: string[]): string {
  return body
    .join("")
    .replace(/[\s│┃─━╌╍┄┅┈┉]+/g, "")
    .replace(COMPACT_AUTO_DENY_RE, "$1");
}

/** FNV-1a over the modal's stable text — same hash the port derivation uses. */
function fingerprintOf(parts: string[]): string {
  const s = parts.join("\0");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Approval prompts are the ones that gate a tool call. Classified from the
 * question and context rather than the option labels, since `1. Yes / 2. No`
 * is shared with plenty of prompts that aren't asking for permission.
 */
function classify(question: string, context: string[]): ModalKind {
  const haystack = [question, ...context].join("\n");
  return /requires confirmation|do you want to proceed|permission|allow this|approve/i.test(
    haystack,
  )
    ? "approval"
    : "input";
}

/**
 * Parse a modal prompt out of `capture-pane` output, or null when the pane
 * isn't sitting on one.
 */
export function detectModalPrompt(pane: string): ModalPrompt | null {
  const lines = pane.split("\n");

  // Index of every non-blank line, bottom-anchored: a modal always renders at
  // the bottom of the pane, above nothing but trailing blanks.
  const filled: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim()) filled.push(i);
  }
  if (filled.length === 0) return null;

  const footerAt = filled
    .slice(-FOOTER_SEARCH_LINES)
    .reverse()
    .find((i) => FOOTER_RE.test(lines[i] ?? ""));
  if (footerAt === undefined) return null;

  // Options: the contiguous numbered run directly above the footer. Blank lines
  // between the block and the footer are fine (the TUI leaves one); a non-blank
  // non-option line ends the search, so a numbered list further up the
  // transcript can never be adopted.
  const options: ModalOption[] = [];
  let cursor = filled.indexOf(footerAt) - 1;
  for (; cursor >= 0; cursor--) {
    const line = lines[filled[cursor]!] ?? "";
    const m = OPTION_RE.exec(line);
    if (!m) break;
    options.unshift({ key: m[2]!, label: m[3]!, selected: Boolean(m[1]) });
  }
  if (options.length < MIN_OPTIONS) return null;
  // Numbered 1..N in order, or it isn't an option list.
  if (options.some((opt, i) => opt.key !== String(i + 1))) return null;

  // Context: the modal body — everything between the option block and the rule
  // that opens the modal region, in reading order. Over the cap we drop from the
  // top: the lines nearest the options (the reason, the question) are the ones
  // worth keeping.
  const body: string[] = [];
  for (let i = cursor; i >= 0; i--) {
    const line = lines[filled[i]!] ?? "";
    if (RULE_RE.test(line)) break;
    body.unshift(line.trim());
  }
  const context = body.slice(-MAX_CONTEXT_LINES);

  // Headline: the last line that actually asks something, else the last line of
  // the body — which for a modal whose body is a single line is the same thing.
  const question = context.findLast((line) => line.includes("?")) ?? context.at(-1) ?? "";

  return {
    kind: classify(question, context),
    question,
    context,
    options,
    footer: (lines[footerAt] ?? "").trim(),
    autoDenySec: parseAutoDeny(context),
    // Selection state is deliberately excluded: arrowing between options is the
    // same modal, and a fingerprint that moved with the cursor would re-announce
    // it on every keypress.
    fingerprint: fingerprintOf([stableBody(body), ...options.map((o) => o.label)]),
  };
}
