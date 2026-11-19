/**
 * Permission prompts answered through Claude Code's `PermissionRequest` hook.
 *
 * Scraping the pane for permission dialogs broke more than once on one TUI
 * detail (the dialog's unattended countdown), and an answer had to be typed
 * into the pane as a keypress. The hook gives the same prompt as data, and its
 * reply is the answer.
 *
 * How Claude Code 2.1.322 behaves, as measured with small spike scripts:
 *
 * - The hook fires for every prompt a yolo session still shows: the built-in
 *   safety checks ("This shell -c script runs rm…") and a PreToolUse hook
 *   answering `ask` (a command guard). Its input carries the tool and its exact input, but
 *   not the reason line the dialog shows.
 * - It runs **in parallel** with the dialog. Whichever answers first wins: a
 *   hook decision dismisses the dialog, and an answer in the terminal sends
 *   the hook SIGTERM, which reaches us as the request being aborted.
 * - When the hook's own timeout expires it is killed and the dialog stays.
 * - When the unattended countdown expires, the CLI blocks the call and tells
 *   the hook nothing. Only the pane shows that the dialog went away, which is
 *   what {@link PermissionRequests.observePane} is for.
 * - In auto mode the CLI ignores a hook's allow, so those prompts are left to
 *   the dialog and the pane scraper.
 *
 * Each request becomes an ordinary `modal_prompt` card with a `hook-` id as its
 * fingerprint, so the UI and session status need nothing new. This class holds
 * no tmux or process state: the session feeds it pane observations and turns
 * its callbacks into events.
 */

import type { ModalOption, ModalPrompt } from "./modal-prompt";

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/**
 * The hook's reply. `decision: null` leaves the prompt to the dialog. `retry`
 * says this agent-host is going away, so the hook should ask the next one.
 */
export interface HookReply {
  decision: PermissionDecision | null;
  retry?: boolean;
}

export interface PermissionRequestInput {
  /** Chosen by the hook, and kept when it re-asks after a restart. */
  requestId: string;
  toolName: string;
  toolInput: unknown;
  permissionMode?: string;
}

export type ClearReason = "answered" | "dismissed" | "superseded";

export interface PermissionRequestsEvents {
  /** Show (or refresh) a prompt card. */
  announce(prompt: ModalPrompt): void;
  /** Settle a card. */
  cleared(fingerprint: string, reason: ClearReason, answered?: string): void;
}

/** The deny reply for "No". `interrupt` ends the turn, as "No" in the terminal does. */
export const DECLINED: PermissionDecision = {
  behavior: "deny",
  message: "The user declined this permission request from Anima.",
  interrupt: true,
};

/** Polls without a dialog on screen before an observed prompt counts as gone. */
const GONE_AFTER_POLLS = 2;
/** Longest tool-input line on a card; the full input is still in the transcript. */
const MAX_INPUT_CHARS = 2_000;

const OPTIONS: ModalOption[] = [
  { key: "1", label: "Yes", selected: true },
  { key: "2", label: "No", selected: false },
];

interface Pending {
  prompt: ModalPrompt;
  reply: (reply: HookReply) => void;
  /** The dialog for it has been seen in the pane. */
  sawDialog: boolean;
  /** Consecutive polls since then without a dialog. */
  missingPolls: number;
}

/** Card fingerprint for a hook request. */
export function hookFingerprint(requestId: string): string {
  return `hook-${requestId}`;
}

function clip(text: string): string {
  return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}…` : text;
}

/** The card body for a tool call: what the dialog's top half would show. */
export function describeToolInput(toolName: string, toolInput: unknown): string[] {
  const input = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<
    string,
    unknown
  >;
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" && input[key] ? (input[key] as string) : undefined;

  if (toolName === "Bash") {
    const lines = ["Bash command"];
    const description = str("description");
    if (description) lines.push(description);
    lines.push(clip(str("command") ?? ""));
    return lines;
  }
  const target = str("file_path") ?? str("notebook_path") ?? str("url") ?? str("path");
  if (target) return [toolName, target];
  const json = JSON.stringify(input);
  return json && json !== "{}" ? [toolName, clip(json)] : [toolName];
}

/** The card for a request, before the dialog's own text is available. */
export function hookPrompt(input: PermissionRequestInput): ModalPrompt {
  return {
    kind: "approval",
    question: "Do you want to proceed?",
    context: describeToolInput(input.toolName, input.toolInput),
    options: OPTIONS.map((o) => ({ ...o })),
    footer: "",
    fingerprint: hookFingerprint(input.requestId),
  };
}

export class PermissionRequests {
  /** In arrival order; the first one is the dialog on screen. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly events: PermissionRequestsEvents) {}

  get size(): number {
    return this.pending.size;
  }

  /** The prompt the pane is showing, if a request is waiting. */
  get current(): ModalPrompt | null {
    return this.head()?.prompt ?? null;
  }

  /**
   * Register a request and wait for its reply. `signal` aborts when the hook's
   * connection drops, which means the hook is gone: answered in the terminal,
   * timed out, or the turn was interrupted.
   */
  request(input: PermissionRequestInput, signal?: AbortSignal): Promise<HookReply> {
    // Claude Code ignores a hook's allow in auto mode; the dialog is the only
    // way to answer, so leave it to the pane scraper.
    if (input.permissionMode === "auto") return Promise.resolve({ decision: null });

    const fingerprint = hookFingerprint(input.requestId);
    return new Promise<HookReply>((resolve) => {
      const existing = this.pending.get(fingerprint);
      if (existing) {
        // The hook re-asked (its connection dropped). The old connection is
        // already gone, so the new one takes over the reply.
        existing.reply = resolve;
      } else {
        this.pending.set(fingerprint, {
          prompt: hookPrompt(input),
          reply: resolve,
          sawDialog: false,
          missingPolls: 0,
        });
      }
      this.events.announce(this.pending.get(fingerprint)!.prompt);

      signal?.addEventListener(
        "abort",
        () => {
          const entry = this.pending.get(fingerprint);
          // A re-ask replaced this connection's reply; only the current one counts.
          if (entry?.reply === resolve) this.settle(fingerprint, "dismissed");
        },
        { once: true },
      );
    });
  }

  /**
   * Answer from Anima. Returns null when `fingerprint` isn't a hook request and
   * none is waiting, so the caller can fall back to answering the pane.
   */
  answer(key: string, fingerprint?: string): { ok: boolean; error?: string } | null {
    const isHook = fingerprint?.startsWith("hook-") ?? false;
    if (!isHook && (fingerprint || this.pending.size === 0)) return null;

    const target = fingerprint ?? this.head()?.prompt.fingerprint;
    const entry = target ? this.pending.get(target) : undefined;
    if (!entry || !target) {
      return { ok: false, error: "That permission prompt is no longer waiting for an answer" };
    }
    const decision: PermissionDecision | undefined =
      key === "1" ? { behavior: "allow" } : key === "2" ? DECLINED : undefined;
    if (!decision) return { ok: false, error: `"${key}" is not one of this prompt's options` };
    this.settle(target, "answered", { decision }, key);
    return { ok: true };
  }

  /**
   * Feed the result of a pane poll (the dialog detected there, or null).
   *
   * The first sighting copies the dialog's own text onto the card: it has the
   * reason line and the countdown, which the hook's input lacks. After that, a
   * dialog missing for {@link GONE_AFTER_POLLS} polls means the CLI settled the
   * prompt without telling the hook (the countdown expired), so the card
   * settles too. A dialog the scraper can't read never counts as gone.
   */
  observePane(dialog: ModalPrompt | null): void {
    const head = this.head();
    if (!head) return;
    if (dialog) {
      head.missingPolls = 0;
      if (head.sawDialog) return;
      head.sawDialog = true;
      head.prompt = {
        ...head.prompt,
        question: dialog.question || head.prompt.question,
        context: dialog.context.length > 0 ? dialog.context : head.prompt.context,
        autoDenySec: dialog.autoDenySec,
      };
      this.events.announce(head.prompt);
      return;
    }
    if (head.sawDialog && ++head.missingPolls >= GONE_AFTER_POLLS) {
      this.settle(head.prompt.fingerprint, "dismissed");
    }
  }

  /**
   * Settle everything. A finished turn or a closed session has nothing left to
   * answer (`decision: null`); a released one tells hooks to ask the next
   * agent-host (`retry`).
   */
  settleAll(reason: ClearReason, reply: HookReply = { decision: null }): void {
    // Deleting the entry being visited is safe in Map iteration.
    for (const fingerprint of this.pending.keys()) {
      this.settle(fingerprint, reason, reply, undefined, false);
    }
  }

  private head(): Pending | undefined {
    return this.pending.values().next().value;
  }

  private settle(
    fingerprint: string,
    reason: ClearReason,
    reply: HookReply = { decision: null },
    answered?: string,
    announceNext = true,
  ): void {
    const entry = this.pending.get(fingerprint);
    if (!entry) return;
    this.pending.delete(fingerprint);
    entry.reply(reply);
    this.events.cleared(fingerprint, reason, answered);
    // The clear put the session back to running; the next waiting request
    // puts it back to awaiting approval.
    const next = this.head();
    if (announceNext && next) this.events.announce(next.prompt);
  }
}
