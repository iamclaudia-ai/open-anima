/**
 * Claude CLI runtime session.
 *
 * Drives the real `claude` TUI in a tmux pane (subscription-compliant auth,
 * tool execution, history, permissions all handled by the CLI) and observes the
 * model stream via a local tee proxy. Implements the same `AgentRuntimeSession`
 * shape as the SDK and Codex providers, so session-host / clients are unchanged.
 *
 * Key behaviors:
 * - Native Anthropic SSE is emitted as `"sse"` events (near-identity mapping).
 * - Haiku pre-flight (title-gen) streams are swallowed so they don't pollute the
 *   chat. (PR 2: route to `session.title_generated`.)
 * - A turn ends only on a non-Haiku `message_stop` with a terminal stop_reason —
 *   `tool_use` continuations stay part of the same logical turn.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { animaLogFile, createLogger, shortId } from "@anima/shared";
import type {
  AgentRuntimeSessionInfo,
  CreateSessionOptions,
  ResumeSessionOptions,
  RuntimeDrain,
  StreamEvent,
} from "../../provider-types";
import { AnthropicTeeProxy, type StreamContext } from "./proxy";
import {
  capturePane,
  killSession,
  killWrapperSessions,
  newSession,
  pasteText,
  runInPane,
  sendKey,
  submit,
} from "./tmux";
import { liveness } from "./liveness";
import { detectModalPrompt, type ModalPrompt } from "./modal-prompt";
import {
  type ClearReason,
  type HookReply,
  type PermissionRequestInput,
  PermissionRequests,
} from "./permission-requests";
import { type PermissionHookTarget, permissionHookEnv } from "./permission-hook";
import { copyImageToClipboard } from "./image-clipboard";
import { ensureMitmCerts } from "./mitm-certs";
import { trustWorkspace } from "./workspace-trust";
import { recallPort, rememberPort } from "./port-registry";
import { SessionJsonlTail, entryTime } from "./jsonl-tail";
import { type ApiErrorInfo, parseEntry } from "./jsonl";
import {
  BackgroundLedger,
  type BackgroundChanges,
  BackgroundSnapshotReader,
  backgroundChanges,
  backgroundSnapshotPath,
  removeBackgroundSnapshot,
} from "./background-work";
import {
  MAX_NUDGES,
  NUDGE_MARKER,
  type NudgeStreak,
  type PendingApiError,
  RECOVER_MAX_AGE_MS,
  checkNudgeReadiness,
  decideOnApiError,
  findPendingApiError,
  inputBoxState,
  isRetryableApiError,
  nudgeText,
  recoveredDelayMs,
  sharedNudgeBreaker,
} from "./api-error-nudge";
import { animaSessionEnv } from "../anima-env";
import { claudePaneName } from "../../pane-names";
import { CLAUDE_FOR_FOLDER, resolveClaudeAccount } from "./claude-account";
import { BUILTIN_PROFILES, LEGACY_PROFILE, type ResolvedProfile } from "../../profiles";
import { type ExtensionMcpTarget, profileCliArgs, writeSessionMcpConfig } from "./profile-args";

const log = createLogger("ClaudeCliSession", animaLogFile("agent-host.log"));

export interface ClaudeCliProviderConfig {
  /** Absolute path to the claude binary (auto-detected if omitted). */
  cliPath?: string;
  /** Base port for the per-session tee proxy (default 31000). */
  basePort?: number;
  /** Interception mode — PR 1 supports "base-url" only. */
  interception?: "base-url" | "mitm";
  /** Fallback model when the session options omit one. */
  model?: string;
  /** Append full request/response JSON to the proxy capture file (debugging). */
  capture?: boolean;
  /** Persona file handed to the CLI (`~` expanded), resolved from `agentHost.persona`. */
  systemPromptFile?: string;
  /** "append" (default) keeps Claude Code's system prompt; "replace" swaps it out. */
  systemPromptMode?: "append" | "replace";
  /** Anima's extension MCP server, for profiles with `mcp: "anima-only"`. */
  extensionMcp?: ExtensionMcpTarget;
  /** Answer permission prompts through the `PermissionRequest` hook. */
  permissionHook?: PermissionHookTarget;
  /** Settings file with Anima's hooks, passed with `--settings` (`hook-settings.ts`). */
  hookSettingsPath?: string;
  /** Where the Stop hook saves background-work snapshots; none read without it. */
  backgroundDir?: string;
  /** Claude Code's config file, where launches pre-trust their folder (default `~/.claude.json`). */
  claudeConfigPath?: string;
}

/**
 * Base of the per-session proxy port range (9000-9999 previously).
 *
 * The old range is crowded on a normal dev machine — this one had 12 foreign
 * listeners in it (OrbStack alone holds 9000-9003, 9100, 9101, 9200, 9440,
 * 9441, 9900, 9901), and every collision forced the port probe to drift, which
 * is what strands a CLI across restarts. 31000-31999 measured completely free,
 * sits beside the gateway's 30086, and is below the OS ephemeral range.
 */
const DEFAULT_BASE_PORT = 31000;
const TERMINAL_STOP = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const INIT_TIMEOUT_MS = 12_000;
const STALE_MS = 5 * 60 * 1000;
/** Oldest liveness snapshot a launch decision may trust. */
const LIVENESS_FRESH_MS = 1_000;
/** Settle time after each Ctrl-V so the TUI reads the clipboard + renders `[Image #N]`. */
const IMAGE_INGEST_MS = 700;
/** Settle delay after a paste before we send Enter to submit. */
const PASTE_SETTLE_MS = 200;
/** Max wait after submit for Claude to start a new turn (proves paste landed). */
const TURN_START_TIMEOUT_MS = 15_000;
/** Max wait for an in-flight turn to clear before we paste a new prompt. */
const PROMPT_READY_TIMEOUT_MS = 60_000;
/** Sample interval for cold-start pane-idle detection. */
const PANE_IDLE_SAMPLE_MS = 250;
/** Consecutive unchanged captures that count as "TUI idle". */
const PANE_IDLE_STABLE_SAMPLES = 3;
/** Cap on the cold-start idle wait. */
const PANE_IDLE_TIMEOUT_MS = 10_000;
/** Max wait for the feedback survey to clear after we dismiss it. */
const SURVEY_CLEAR_TIMEOUT_MS = 2_000;
/** Poll interval while waiting for the survey to clear. */
const SURVEY_CLEAR_SAMPLE_MS = 150;
/**
 * Modal-prompt poll cadence, mid-turn. A hook confirmation lands while a tool
 * call is in flight, which is when we care about latency — this is the interval
 * that decides how long a blocked session looks merely busy.
 */
const MODAL_POLL_ACTIVE_MS = 1_500;
/**
 * Modal-prompt poll cadence when no turn is in flight. Deliberately slow: each
 * poll forks a `tmux capture-pane`, and with a dozen live panes a uniform fast
 * poll would be a steady stream of processes for a case that is rare when idle
 * (the trust dialog at launch, or a modal left standing by a turn we never saw
 * start — which is exactly the post-restart adopted pane).
 */
const MODAL_POLL_IDLE_MS = 10_000;
/** Max wait for a modal to clear after we answer it. */
const MODAL_CLEAR_TIMEOUT_MS = 4_000;
/** Poll interval while waiting for an answered modal to clear. */
const MODAL_CLEAR_SAMPLE_MS = 150;
/** Wait before re-checking a pane that wasn't ready for a nudge (repainting, no input box). */
const NUDGE_RETRY_MS = 15_000;
/** Not-ready re-checks one nudge may spend before the session is marked stalled. */
const NUDGE_MAX_DEFERS = 8;
/**
 * An API error stamped this long before the tail started is history, not news.
 * The tail seeks to EOF, but reads a file from the top when it first appears or
 * shrinks, and an old give-up must never trigger a nudge after a reload.
 */
const API_ERROR_HISTORY_SLACK_MS = 5_000;

/**
 * Detect the CLI's periodic "How is Claude doing this session?" feedback
 * survey. Matches the distinctive options row — `1: Bad … 3: Good … 0: Dismiss`
 * on a single line — rather than the question text alone, so conversation
 * scrollback that merely *mentions* the survey can't trigger a false positive
 * (which would leak a stray "3" into the next prompt). `.` never crosses a
 * newline, so all three markers must share one captured line, exactly as the
 * TUI renders them.
 */
export function isFeedbackSurvey(pane: string): boolean {
  return /\b1:\s*Bad\b.*\b3:\s*Good\b.*\b0:\s*Dismiss\b/i.test(pane);
}

interface EmittedToolResult {
  tool_use_id: unknown;
  content: unknown;
  is_error: unknown;
}

/**
 * Collect `tool_result` blocks from the trailing user messages of a CLI
 * continuation request.
 *
 * The CLI never streams tool results — it sends them back in the *next*
 * request's message array, so this reconstructs the event the UI needs to stop
 * a tool call's spinner. Anthropic's API requires tool results to immediately
 * follow the assistant message that requested them, so the run of user
 * messages at the tail is exactly the current batch; the first non-user
 * message ends it and keeps the scan off the rest of the conversation.
 *
 * Scanning that run — rather than only `messages.at(-1)` — is what makes this
 * robust. The CLI appends a `role: "system"` reminder message after the tool
 * results, which displaces them from the last slot and stranded the spinner
 * forever. Proxy capture confirms the shape: of 62 agent requests carrying tool
 * results, 50 ended with the results and 10 had a trailing `system` message
 * (the remaining 2 were `assistant then user`, i.e. an already-emitted batch).
 *
 * So only an `assistant` message ends the scan — anything else that isn't a
 * user message is stepped over, since injected reminders must not hide the
 * results behind them.
 */
export function collectTrailingToolResults(messages: unknown[]): EmittedToolResult[] {
  const collected: EmittedToolResult[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown } | null;
    // The assistant turn that requested these results bounds the batch.
    if (message?.role === "assistant") break;
    // Step over injected reminders and any non-user message.
    if (message?.role !== "user") continue;
    if (!Array.isArray(message.content)) continue;

    // Walk the message's own blocks in reverse too, so a single flat reverse
    // at the end restores the original request order.
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j] as Record<string, unknown> | null;
      if (block?.type !== "tool_result") continue;
      collected.push({
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      });
    }
  }

  return collected.reverse();
}

function findClaude(configPath?: string): string {
  if (configPath && existsSync(configPath)) return configPath;
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return Bun.which("claude") ?? "claude";
}

interface ParsedPrompt {
  text: string;
  images: Array<{ data: string; mediaType: string }>;
}

/** Split inbound content into submit text and base64 image attachments. */
function parsePromptContent(content: string | unknown[]): ParsedPrompt {
  if (typeof content === "string") return { text: content, images: [] };
  const images: ParsedPrompt["images"] = [];
  const textParts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    if (r.type === "text") {
      textParts.push(String(r.text ?? ""));
    } else if (r.type === "image") {
      const src = (r.source ?? {}) as Record<string, unknown>;
      const data = src.data;
      if (typeof data === "string" && data) {
        const mediaType = typeof src.media_type === "string" ? src.media_type : "image/png";
        images.push({ data, mediaType });
      }
    }
  }
  return { text: textParts.filter(Boolean).join("\n"), images };
}

/**
 * Strip an Anima model-variant suffix like "[1m]" before passing `--model` to
 * the CLI. Anthropic rejects "claude-opus-4-7[1m]" as a model name (404
 * not_found); the 1M context window rides on the `context-1m-2025-08-07` beta
 * header the CLI sends automatically, so the bare model id is what we want.
 */
function sanitizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, "").trim();
}

/** Deterministic port from session id so resume reuses the same proxy. */
/**
 * Deterministic per-session proxy port.
 *
 * FNV-1a rather than a sum of char codes: summing is order-independent, so
 * session UUIDs — same alphabet, same length — pile into a narrow central band.
 * Measured across a few hundred real session ids, the sum crowded them into
 * about 70% of the 1000 available slots with half of them sharing a port;
 * FNV-1a uses the full range and drops that to about a third (the residual is
 * just the birthday bound).
 *
 * Collisions still have to be handled by the caller — this only makes them
 * rarer.
 */
function derivePort(base: number, id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return base + (h % 1000);
}

export class ClaudeCliSession extends EventEmitter {
  readonly id: string;

  private proxy: AnthropicTeeProxy | null = null;
  private readonly tmuxName: string;
  private proxyPort = 0;

  private readonly cwd: string;
  /** Bare model id (suffix stripped) — what actually goes on the wire. */
  private readonly model: string;
  /**
   * Model id passed to the CLI's `--model`. Keeps the `[1m]` variant so the TUI's
   * context meter and auto-compaction threshold use the 1M window; the proxy
   * rewrites it to the bare id on the wire so the API never sees `[1m]`.
   */
  private readonly cliModel: string;
  /** True when the configured model carried the `[1m]` 1M-context variant. */
  private readonly wants1m: boolean;
  private readonly systemPrompt?: string;
  private readonly isResume: boolean;
  /** Transport: "base-url" (ANTHROPIC_BASE_URL) or "mitm" (HTTPS_PROXY + CA). */
  private readonly interception: "base-url" | "mitm";
  /** CA path for NODE_EXTRA_CA_CERTS — set when interception is "mitm". */
  private caPath = "";

  private _isStarted = false;
  private _isClosed = false;
  private _turnActive = false;
  /** reqId of the in-flight agent request — the target of post-interrupt suppression. */
  private _activeReqId: string | null = null;
  /**
   * reqIds whose remaining SSE we drop. An interrupted request is NOT cancelled
   * upstream — the TUI stops rendering it but the stream finishes server-side, so
   * the proxy keeps receiving deltas. Suppressing by reqId (not a global flag)
   * means a fresh turn opened during the ~30s drain still streams normally.
   */
  private readonly _suppressedReqIds = new Set<string>();

  /**
   * `tool_use_id`s already surfaced as `request_tool_results` this turn, so a
   * retried request body can't replay them. Cleared in `endTurn()` — ids are
   * unique per turn, so the set stays bounded by the current turn's tool count.
   */
  private readonly _emittedToolResultIds = new Set<string>();
  /** Tails our own JSONL transcript — the only signal for a direct-tmux interrupt. */
  private readonly tail: SessionJsonlTail;
  /**
   * True once we've observed at least one proxy SSE event since (re)start.
   * Until then, `_turnActive` is just a default — the *actual* TUI could be
   * mid-turn from before we attached. Cold start uses pane-idle detection to
   * bootstrap before trusting `_turnActive`.
   */
  private _turnStateKnown = false;
  /** True once claude has been launched at least once — recovery uses --resume. */
  private _launched = false;

  /** The open API-error streak: nudges sent since the last give-up entry. */
  private _nudgeStreak: NudgeStreak | null = null;
  private _nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private _nudgeDefers = 0;
  /** When the tail last started, to tell a fresh API error from transcript history. */
  private _tailStartedAt = 0;
  /** A give-up the transcript already ended on at start, handled a tick later. */
  private _recoveredError: PendingApiError | null = null;

  /** Background work this session waits on between turns. */
  private readonly background = new BackgroundLedger();
  /** The Stop hook's snapshot file; null without a configured `backgroundDir`. */
  private readonly backgroundSnapshot: { path: string; reader: BackgroundSnapshotReader } | null;

  /** The modal currently on screen, as last observed by the watcher. */
  private _modal: ModalPrompt | null = null;
  private _modalTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Permission prompts waiting on the hook. While one is, its card is the
   * prompt on screen and the pane scraper only feeds it observations.
   */
  private readonly permissions = new PermissionRequests({
    announce: (prompt) => this.emitModalPrompt(prompt),
    cleared: (fingerprint, reason, answered) =>
      this.emitModalCleared(fingerprint, reason, answered),
  });

  // Turn tracking — the latest non-terminal/terminal stop reason on the agent stream.
  private lastStopReason = "";

  /** Permission profile, applied as launch flags (the CLI can't change it later). */
  private readonly profile: ResolvedProfile;

  private readonly createdAt = Date.now();
  private lastActivityTime = Date.now();
  /** The Claude account of the last launch; `default` is Claude Code's own login. */
  private account: string | null = null;

  constructor(
    id: string,
    options: CreateSessionOptions | ResumeSessionOptions,
    isResume: boolean,
    private readonly config: ClaudeCliProviderConfig = {},
  ) {
    super();
    this.id = id;
    this.tmuxName = claudePaneName(id);
    this.cwd = options.cwd;
    const rawModel = options.model || config.model || "claude-opus-4-6";
    this.wants1m = /\[1m\]/i.test(rawModel);
    this.model = sanitizeModel(rawModel);
    this.cliModel = rawModel;
    this.systemPrompt = "systemPrompt" in options ? options.systemPrompt : undefined;
    this.profile = options.profile ?? { name: LEGACY_PROFILE, ...BUILTIN_PROFILES[LEGACY_PROFILE] };
    this.isResume = isResume;
    this.interception = config.interception === "mitm" ? "mitm" : "base-url";
    // A direct-tmux Escape (user typing in an attached pane) never calls
    // interrupt(); the JSONL marker is the only signal that reaches us. Funnel it
    // into the same idempotent abort as the web-UI path.
    this.tail = new SessionJsonlTail(this.cwd, this.id);
    this.tail.on("interrupt", () => this.abortTurn("jsonl_marker"));
    // A prompt is "received" the instant the CLI records it in the transcript —
    // as a `type:"user"` entry (fresh prompt) or a `queue-operation/enqueue`
    // (steer). This is the receipt that confirms a paste landed even when no SSE
    // `message_start` follows (an in-tool steer injected at a tool boundary).
    // A real prompt (not our own nudge) ends an API-error streak: someone is
    // driving the session again.
    this.tail.on("user_prompt", (text: string) => {
      this.emit("prompt_received");
      if (!text.startsWith(NUDGE_MARKER)) this.endNudgeStreak("prompt");
    });
    this.tail.on("enqueue", (content: string) => {
      this.emit("prompt_received");
      if (!content.startsWith(NUDGE_MARKER)) this.endNudgeStreak("prompt");
    });
    this.tail.on("api_error", (info: ApiErrorInfo, timestamp?: string) =>
      this.handleApiError(info, timestamp),
    );
    this.tail.on("background", (changes: BackgroundChanges, at: number) =>
      this.background.apply(changes, at),
    );
    const snapshotPath = config.backgroundDir
      ? backgroundSnapshotPath(config.backgroundDir, id)
      : null;
    this.backgroundSnapshot = snapshotPath
      ? { path: snapshotPath, reader: new BackgroundSnapshotReader(snapshotPath) }
      : null;
  }

  async start(): Promise<void> {
    if (this._isStarted) throw new Error("Session already started");
    const reused = await this.ensureRunning();
    this._isStarted = true;
    this._isClosed = false;
    // Fresh instance — no SSE history, so we can't trust `_turnActive` until
    // either a proxy event arrives or pane-idle detection bootstraps us.
    this._turnStateKnown = false;
    this.lastActivityTime = Date.now();
    this._tailStartedAt = Date.now();
    this.tail.start();
    // Adopting a live `claude` (an agent-host restart): it may have started
    // background work while nobody was tailing.
    if (reused) this.replayBackgroundHistory();
    this.startModalWatch();
    this.emit("ready", { sessionId: this.id });
    this.emit("process_started");
    log.info("Started", { id: this.id.slice(0, 8), port: this.proxyPort, reuse: reused });
    // Our caller wires this session's events only after start() returns, so
    // the recovered error is handled on the next tick, not here.
    this._recoveredError = this.findRecoverableApiError();
    if (this._recoveredError) setTimeout(() => this.recoverApiError(), 0);
  }

  /**
   * An API give-up Claude Code wrote before this start, still unanswered.
   *
   * The common case is our own restart: it cuts every stream agent-host
   * proxies, the CLI records the give-up while nobody is tailing, and the new
   * tail starts after it. Same policy as a live give-up, with the
   * backoff counted from when it happened.
   */
  private findRecoverableApiError(): PendingApiError | null {
    let pending: PendingApiError | null;
    try {
      pending = findPendingApiError(this.tail.historyLines());
    } catch (err) {
      log.warn("Couldn't read the transcript for an earlier API error", {
        id: shortId(this.id),
        error: String(err),
      });
      return null;
    }
    if (!pending) return null;
    const at = pending.timestamp ? Date.parse(pending.timestamp) : NaN;
    const ageMs = Date.now() - at;
    if (!Number.isFinite(ageMs) || ageMs > RECOVER_MAX_AGE_MS) {
      log.info("Transcript ends on an API error too old to nudge", {
        id: shortId(this.id),
        timestamp: pending.timestamp,
      });
      return null;
    }
    return pending;
  }

  private recoverApiError(): void {
    const pending = this._recoveredError;
    this._recoveredError = null;
    if (!pending || this._isClosed || !this._isStarted) return;
    log.info("Recovering an API error written before this start", {
      id: shortId(this.id),
      timestamp: pending.timestamp,
      attempts: pending.attempts,
    });
    this._nudgeStreak =
      pending.attempts > 0 ? { attempts: pending.attempts, lastError: pending.info } : null;
    this.handleApiError(pending.info, pending.timestamp, true);
  }

  /** Lazily (re)start the tee proxy on this session's deterministic port. */
  private async ensureProxy(): Promise<void> {
    if (this.proxy) return;
    let tls: { key: string; cert: string } | undefined;
    if (this.interception === "mitm") {
      const certs = ensureMitmCerts();
      tls = { key: certs.key, cert: certs.cert };
      this.caPath = certs.caPath;
    }
    // Which port to offer, in descending order of authority:
    //
    //   1. What a live CLI is already targeting — ground truth. It read the URL
    //      once at startup and cannot be told a new one, so binding anywhere
    //      else strands it (ConnectionRefused).
    //   2. What we last bound for this session — covers a CLI that's alive but
    //      unmatchable, and a pane whose CLI is dead and about to be relaunched.
    //   3. Derivation — a first-ever launch.
    await liveness.fresh(LIVENESS_FRESH_MS);
    const pinnedByCli = await liveness.proxyPort(this.id);
    const remembered = recallPort(this.id);
    const derived = derivePort(this.config.basePort ?? DEFAULT_BASE_PORT, this.id);
    const preferred = pinnedByCli ?? remembered ?? derived;

    if (preferred !== derived) {
      log.info("Reusing a previously-bound proxy port", {
        id: this.id.slice(0, 8),
        port: preferred,
        source: pinnedByCli ? "running-cli" : "registry",
        derived,
      });
    }

    this.proxy = new AnthropicTeeProxy({
      port: preferred,
      // Only a *live* CLI pins the port. A remembered port is a preference —
      // if something else holds it now, probing is better than refusing to
      // start, because no process is depending on that exact number yet.
      allowPortProbe: pinnedByCli === null,
      onEvent: (e, ctx) => this.handleProxyEvent(e, ctx),
      onRequestBody: (b, ctx) => this.handleRequestBody(b, ctx),
      capture: this.config.capture,
      // Gate 1M-beta injection on this session's model: only requests on this
      // exact model get it. Subagent calls on other models (e.g. Haiku) must not
      // carry the Opus-tier 1M beta or the API 400s. undefined = never.
      context1mModel: this.wants1m ? this.model : undefined,
      interception: this.interception,
      tls,
    });
    this.proxyPort = await this.proxy.start();
    // Record what we actually bound, so the next restart can offer it back
    // even if the process lookup comes up empty.
    rememberPort(this.id, this.proxyPort);
  }

  /**
   * Make the runtime live: proxy up, tmux pane up, and the `claude` process
   * actually running. Recovers whatever is missing and returns true only when a
   * fully-healthy session was reused untouched.
   *
   * - pane + claude alive → reuse as-is.
   * - pane alive, claude dead → relaunch in-pane (keeps any attached client).
   * - no pane → spawn a fresh detached session.
   *
   * Throws if claude still isn't running after a (re)launch so the caller can
   * surface the failure instead of silently pasting into a dead pane.
   */
  private async ensureRunning(): Promise<boolean> {
    await this.ensureProxy();

    await liveness.fresh(LIVENESS_FRESH_MS);
    // Never relaunch on a cached "dead": confirm it with a snapshot taken now,
    // because the branch below kills the pane.
    if (!this.runtimeAlive()) await liveness.refresh();
    if (this.runtimeAlive()) return true;

    // Background work dies with `claude`: a fresh process starts with none.
    this.resetBackground();
    if (liveness.tmuxAlive(this.tmuxName)) {
      // Pane survived but claude exited (crash, or a manually re-created shell).
      this.launchInPane();
    } else {
      killSession(this.tmuxName); // clear any half-dead record
      this.spawn();
    }
    await this.waitForReady();

    await liveness.refresh();
    if (!liveness.claudeAlive(this.id)) {
      throw new Error(`Claude CLI failed to start in tmux session ${this.tmuxName}`);
    }
    this._isClosed = false;
    // We just (re)launched claude; the prior `_turnActive` is stale.
    this._turnStateKnown = false;
    this._turnActive = false;
    return false;
  }

  /**
   * Absolute path to the configured persona file, or undefined.
   *
   * The CLI hard-errors and exits on a missing `--system-prompt[-file]` path,
   * which would break every launch, so a bad config is downgraded to a warning
   * and the flag is dropped.
   */
  private resolveSystemPromptFile(): string | undefined {
    const raw = this.config.systemPromptFile?.trim();
    if (!raw) return undefined;
    const path = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    if (!existsSync(path)) {
      log.warn("systemPromptFile not found — launching without it", { path });
      return undefined;
    }
    return path;
  }

  /** Build the claude argv + env. `resume` picks --resume vs --session-id. */
  private claudeCommand(resume: boolean): { command: string[]; env: Record<string, string> } {
    const claudeBin = findClaude(this.config.cliPath);
    const args = resume ? ["--resume", this.id] : ["--session-id", this.id];
    const mcpConfigPath =
      this.profile.mcp === "anima-only" && this.config.extensionMcp
        ? writeSessionMcpConfig(this.id, this.config.extensionMcp, this.profile.mcpServers)
        : undefined;
    args.push("--model", this.cliModel, ...profileCliArgs(this.profile, mcpConfigPath));
    if (this.config.hookSettingsPath) args.push("--settings", this.config.hookSettingsPath);
    // Persona file first: in "replace" mode it swaps out Claude Code's own
    // system prompt, so it must not clobber the per-session context below.
    const personaFile = this.resolveSystemPromptFile();
    if (personaFile) {
      const flag =
        this.config.systemPromptMode === "replace"
          ? "--system-prompt-file"
          : "--append-system-prompt-file";
      args.push(flag, personaFile);
    }
    // Per-session context (memory bootstrap + time reminder) always appends,
    // whichever mode the persona uses.
    if (this.systemPrompt && this.systemPrompt.trim()) {
      args.push("--append-system-prompt", this.systemPrompt.trim());
    }
    // Force the subscription OAuth path: clear any API-key vars. Then route the
    // CLI at our proxy per transport — base-url points ANTHROPIC_BASE_URL at the
    // origin; mitm sets HTTPS_PROXY + a trusted CA and leaves the base URL unset
    // (so it talks to the real api.anthropic.com, which we transparently MITM).
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ...animaSessionEnv(this.id),
      ...(this.config.permissionHook ? permissionHookEnv(this.config.permissionHook, this.id) : {}),
    };
    if (this.interception === "mitm") {
      const proxyUrl = `http://127.0.0.1:${this.proxyPort}`;
      env.HTTPS_PROXY = proxyUrl;
      env.HTTP_PROXY = proxyUrl;
      env.NODE_EXTRA_CA_CERTS = this.caPath;
      env.ANTHROPIC_BASE_URL = ""; // clear any inherited base url
    } else {
      env.ANTHROPIC_BASE_URL = `http://localhost:${this.proxyPort}`;
    }
    // The launcher picks the Claude account from the folder, exports its
    // token, and execs CLAUDE_BIN, so the token never sits on this command line.
    this.resolveAccount();
    env.CLAUDE_BIN = claudeBin;
    return { command: [CLAUDE_FOR_FOLDER, ...args], env };
  }

  /**
   * Resolve the folder's Claude account before a launch. Throws with the
   * launcher's message when the account has no token, so the prompt fails with
   * the reason instead of waiting on a pane whose launch exited.
   */
  private resolveAccount(): void {
    const account = resolveClaudeAccount(this.cwd);
    if (account !== this.account) {
      log.info("Claude account for session", { sessionId: shortId(this.id), account });
    }
    this.account = account;
  }

  /**
   * Pre-trust the folder before claude starts there, so its workspace-trust
   * dialog never comes up in a pane nobody is watching (any profile: it shows
   * even under --dangerously-skip-permissions). A failure only costs the
   * dialog, so it never blocks the launch.
   */
  private trustCwd(): void {
    try {
      if (trustWorkspace(this.cwd, this.config.claudeConfigPath)) {
        log.info("Pre-trusted folder for Claude Code", {
          sessionId: shortId(this.id),
          cwd: this.cwd,
        });
      }
    } catch (error) {
      log.warn("Could not pre-trust folder", { cwd: this.cwd, error: String(error) });
    }
  }

  private spawn(): void {
    // First launch of a freshly-created session creates it (--session-id); every
    // later (re)launch resumes the now-existing session.
    const { command, env } = this.claudeCommand(this.isResume || this._launched);
    this.trustCwd();
    newSession({ name: this.tmuxName, cwd: this.cwd, command, env });
    this._launched = true;
  }

  private launchInPane(): void {
    const { command, env } = this.claudeCommand(true);
    this.trustCwd();
    runInPane(this.tmuxName, command, env);
    this._launched = true;
  }

  /**
   * Does this pane capture show a rendered Claude TUI? Looks for stable
   * markers that appear in *any* rendered state — fresh launch, resumed
   * session, mid-turn — so a resumed pane (where the welcome banner has
   * scrolled off) doesn't get treated as empty.
   *
   * - `bypass permissions on` — bottom-bar status text, present once the
   *   TUI has fully drawn its chrome (every YOLO-mode session, fresh or
   *   resumed). The reliable marker.
   * - `⏵⏵` — the bypass-permissions indicator on the same row.
   * - `│\s*>` — the input box for fresh sessions where the bottom bar
   *   may be scrolled off in `capture-pane` output.
   * - `Welcome to Claude` / `Welcome back` — startup banner (fresh launch).
   *
   * An empty / whitespace-only pane returns false even if "stable" — the
   * TUI hasn't painted yet, so pasting into it would land in a void.
   */
  private static tuiRendered(pane: string): boolean {
    return /bypass permissions on|⏵⏵|│\s*>|Welcome (to Claude|back)/i.test(pane);
  }

  /** Poll the pane until the TUI input box renders. */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + INIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (ClaudeCliSession.tuiRendered(capturePane(this.tmuxName))) return;
    }
    log.warn("waitForReady timed out — no TUI markers in pane", {
      id: this.id.slice(0, 8),
      paneTail: this.paneTail(6),
    });
  }

  async prompt(content: string | unknown[]): Promise<void> {
    const { text, images } = parsePromptContent(content);
    log.info("prompt received", {
      ...this.stateSnapshot(),
      chars: text.length,
      images: images.length,
      contentType:
        typeof content === "string" ? "string" : Array.isArray(content) ? "array" : typeof content,
    });
    if (!text.trim() && images.length === 0) {
      log.warn("prompt resolved to empty content — nothing sent to TUI", {
        id: this.id.slice(0, 8),
      });
      return;
    }

    // Escape hatch: `/restart` tears the runtime down and relaunches with
    // --resume, recovering from a wedged TUI (e.g. stuck in /compact confirm,
    // input swallowed by a modal). Doesn't get pasted to the CLI.
    if (images.length === 0 && text.trim() === "/restart") {
      await this.handleRestartCommand();
      return;
    }

    // Durability: verify (and recover) proxy + tmux + claude before every send,
    // so an idle-reaped, crashed, or hand-recreated session heals automatically
    // instead of pasting into a dead or shell-only pane.
    const reused = await this.ensureRunning();
    this._isStarted = true;
    if (!reused) {
      log.info("prompt recovered dead runtime before send", this.stateSnapshot());
    }
    this.lastActivityTime = Date.now();

    // Positive ready signal before pasting: only that the TUI has painted its
    // input box (cold-start bootstrap via pane-idle detection). We do NOT wait
    // for the turn to clear — a busy pane is fine, the CLI queues the paste as a
    // steer. Never sends destructive keys to "unstick" the TUI.
    const ready = await this.waitForPromptReady(PROMPT_READY_TIMEOUT_MS);
    if (!ready.ok) {
      log.warn("TUI not ready for prompt — aborting submit", {
        ...this.stateSnapshot(),
        reason: ready.reason,
      });
      const hint = `The CLI's input box hasn't rendered yet (pane not ready). Attach with \`tmux attach -t ${this.tmuxName}\` to check, then resend.`;
      this.emit("sse", {
        type: "runtime_error",
        subtype: "submit_failed",
        timestamp: new Date().toISOString(),
        reason: ready.reason,
        message: `Your prompt didn't reach Claude (${ready.reason}). ${hint}`,
        paneTail: this.paneTail(10),
        hint,
      } satisfies StreamEvent);
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: "submit_failed",
      } satisfies StreamEvent);
      return;
    }

    // A modal owns the keyboard: pasting into one types the prompt at a yes/no
    // dialog, where the first character is read as an option key. Refuse, and
    // say what's actually blocking — this is the state that used to look like a
    // hang. The watcher has already announced it, so the UI can offer the
    // answer buttons right beside this error.
    const blocking = this.permissions.current ?? detectModalPrompt(capturePane(this.tmuxName));
    if (blocking) {
      const hint = `Answer it from the session view, or attach with \`tmux attach -t ${this.tmuxName}\`.`;
      this.emit("sse", {
        type: "runtime_error",
        subtype: "submit_failed",
        timestamp: new Date().toISOString(),
        reason: "modal_prompt",
        message: `Your prompt didn't reach Claude — the CLI is waiting on a prompt: "${blocking.question}". ${hint}`,
        fingerprint: blocking.fingerprint,
        hint,
      } satisfies StreamEvent);
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: "modal_prompt",
      } satisfies StreamEvent);
      // Announced last, deliberately: `turn_stop` writes `completed`, so a modal
      // announced before it would have its `awaiting_approval` overwritten one
      // line later — the session would go back to looking finished. A hook
      // prompt is re-announced as itself, never adopted as a scraped modal.
      if (this.permissions.current) this.emitModalPrompt(this.permissions.current);
      else this.setModal(blocking);
      return;
    }

    // Dismiss any feedback survey sitting on the idle input before we
    // paste — its number keys are captured by the survey widget, not the input
    // box, so a lingering survey could swallow our first keystroke.
    await this.dismissFeedbackSurveyIfPresent();

    this._turnActive = true;

    // Attach images first: load each onto the macOS clipboard and Ctrl-V it into
    // the input (claude reads the pasteboard on Ctrl-V), giving the TUI time to
    // ingest and render the `[Image #N]` placeholder before the next paste.
    let pasted = 0;
    for (const img of images) {
      if (copyImageToClipboard(img.data, img.mediaType)) {
        sendKey(this.tmuxName, "C-v");
        await new Promise((r) => setTimeout(r, IMAGE_INGEST_MS));
        pasted++;
      } else {
        log.warn("image clipboard paste failed — skipping attachment", {
          id: this.id.slice(0, 8),
          mediaType: img.mediaType,
        });
      }
    }

    // Paste text + submit, then confirm the CLI accepted it — via a fresh turn's
    // `message_start` OR the JSONL receipt for a steer the CLI queues. We defer
    // to the CLI: an idle pane yields a new turn, a busy pane queues the text.
    // No retry-with-Esc — on no receipt we surface submit_failed cleanly.
    if (text.trim()) {
      const landed = await this.pasteSubmitAndConfirm(text);
      if (!landed) {
        this.emit("sse", {
          type: "turn_stop",
          timestamp: new Date().toISOString(),
          stop_reason: "submit_failed",
        } satisfies StreamEvent);
        this.endTurn();
        return;
      }
      log.info("prompt submitted to tmux", {
        ...this.stateSnapshot(),
        images: pasted,
      });
      return;
    }
    submit(this.tmuxName);
    log.info("prompt submitted to tmux", {
      ...this.stateSnapshot(),
      images: pasted,
    });
  }

  /** Snapshot of runtime state — included in every prompt-path log entry. */
  private stateSnapshot(): Record<string, unknown> {
    return {
      id: this.id.slice(0, 8),
      tmux: this.tmuxName,
      tmuxAlive: liveness.tmuxAlive(this.tmuxName),
      claudeAlive: liveness.claudeAlive(this.id),
      started: this._isStarted,
      closed: this._isClosed,
      turnActive: reportedTurnActive(this._turnStateKnown, this._turnActive),
      launched: this._launched,
      proxyPort: this.proxyPort,
      lastActivityMs: Date.now() - this.lastActivityTime,
    };
  }

  /** Last `lines` lines of the pane — handy for "what was on screen when X failed". */
  private paneTail(lines: number): string {
    return capturePane(this.tmuxName).split("\n").slice(-lines).join("\n");
  }

  /**
   * Confirm the pane can accept a paste — WITHOUT blocking on turn state. We
   * defer turn handling to the CLI: pasting into an idle pane starts a fresh
   * turn; pasting into a busy pane is queued by the CLI (a steer). The only
   * thing we still guard is the one failure the CLI can't recover from — pasting
   * before the TUI has painted its input box.
   *
   * Cold path only (no SSE seen since start/resume): sample `capture-pane` until
   * the TUI markers render and stabilize. Hot path: we've seen SSE, so the TUI
   * is definitely up — return immediately, busy or not.
   *
   * Returns `{ ok: false, reason }` on timeout so the caller can surface a
   * specific `submit_failed`.
   */
  private async waitForPromptReady(
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; reason: "pane_not_idle" }> {
    if (!this._turnStateKnown) {
      const idleDeadline = Math.min(Date.now() + timeoutMs, Date.now() + PANE_IDLE_TIMEOUT_MS);
      if (!(await this.waitForPaneIdle(idleDeadline))) {
        return { ok: false, reason: "pane_not_idle" };
      }
    }
    return { ok: true };
  }

  /**
   * Cold-start TUI readiness: wait for the pane to (a) actually contain
   * rendered TUI markers (`│ >` / shortcuts / banner) and (b) be stable
   * across `PANE_IDLE_STABLE_SAMPLES` consecutive captures. The marker
   * requirement is what we were missing — an empty pane is "stable" but
   * very much not ready: pasting lands in a void before the TUI paints.
   */
  private async waitForPaneIdle(deadline: number): Promise<boolean> {
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PANE_IDLE_SAMPLE_MS));
      const pane = capturePane(this.tmuxName);
      if (!ClaudeCliSession.tuiRendered(pane)) {
        stable = 0;
        last = pane;
        continue;
      }
      if (pane === last) {
        if (++stable >= PANE_IDLE_STABLE_SAMPLES) return true;
      } else {
        stable = 0;
        last = pane;
      }
    }
    return false;
  }

  /**
   * The CLI periodically renders a "How is Claude doing this session?" feedback
   * survey (`1: Bad  2: Fine  3: Good  0: Dismiss`) above the idle input box.
   * When present, dismiss it with "0" before we paste: its number keys are
   * captured by the widget, not the input box, so leaving it up could swallow
   * our first keystroke. This is NOT blind key injection: we only ever press "0"
   * on a positive on-screen match (the matched options row includes
   * `0: Dismiss`), and confirm the survey cleared before returning.
   */
  private async dismissFeedbackSurveyIfPresent(): Promise<void> {
    if (!isFeedbackSurvey(capturePane(this.tmuxName))) return;
    log.info("feedback survey detected — dismissing it", { id: this.id.slice(0, 8) });
    sendKey(this.tmuxName, "0");
    const deadline = Date.now() + SURVEY_CLEAR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SURVEY_CLEAR_SAMPLE_MS));
      if (!isFeedbackSurvey(capturePane(this.tmuxName))) return;
    }
    log.warn("feedback survey still present after dismissing it", {
      id: this.id.slice(0, 8),
      paneTail: this.paneTail(6),
    });
  }

  /**
   * Watch the pane for modal prompts.
   *
   * A modal is the one CLI state with no out-of-band signal at all: no SSE, no
   * JSONL entry, nothing on the proxy. The pane is the only place it exists, so
   * a poll is the only way to see it. Self-rescheduling rather than
   * `setInterval` so the cadence can follow the turn — see the two constants.
   */
  private startModalWatch(): void {
    if (this._modalTimer) return;
    const tick = (): void => {
      this._modalTimer = null;
      if (this._isClosed || !this._isStarted) return;
      try {
        this.pollModal();
      } catch (err) {
        // A capture failure is not worth tearing the watcher down for — the
        // pane may simply have died, which the next prompt heals.
        log.warn("modal poll failed", {
          id: this.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.scheduleModalPoll(tick);
    };
    this.scheduleModalPoll(tick);
  }

  private scheduleModalPoll(tick: () => void): void {
    const delay = this._turnActive ? MODAL_POLL_ACTIVE_MS : MODAL_POLL_IDLE_MS;
    this._modalTimer = setTimeout(tick, delay);
    // Never hold the process open for a poll.
    this._modalTimer.unref?.();
  }

  private stopModalWatch(): void {
    if (this._modalTimer) clearTimeout(this._modalTimer);
    this._modalTimer = null;
  }

  /**
   * One pass: capture, detect, and announce only on a *change*. The fingerprint
   * excludes the selection marker, so arrowing between options in an attached
   * pane doesn't re-announce the same prompt.
   */
  private pollModal(): void {
    if (!liveness.tmuxAlive(this.tmuxName)) return;
    const found = detectModalPrompt(capturePane(this.tmuxName));
    // A hook request owns the prompt on screen: the pane only adds its text to
    // the card, and shows when the CLI settled it behind the hook's back.
    if (this.permissions.size > 0) {
      this.permissions.observePane(found);
      return;
    }
    if (found && found.fingerprint === this._modal?.fingerprint) return;
    if (found) {
      this.setModal(found);
    } else if (this._modal) {
      this.clearModal("dismissed");
    }
  }

  private setModal(modal: ModalPrompt): void {
    // A different modal replacing the one on record settles the old one first,
    // so its card stops offering buttons instead of piling up beside the new
    // one. Same fingerprint is a re-announce, which the UI dedupes.
    if (this._modal && this._modal.fingerprint !== modal.fingerprint) {
      this.clearModal("superseded");
    }
    this._modal = modal;
    this.emitModalPrompt(modal);
  }

  /** Announce a prompt card: a scraped modal or a hook request. */
  private emitModalPrompt(modal: ModalPrompt): void {
    log.info("modal prompt detected", {
      id: this.id.slice(0, 8),
      kind: modal.kind,
      question: modal.question.slice(0, 120),
      options: modal.options.length,
      fingerprint: modal.fingerprint,
    });
    this.emit("sse", {
      type: "modal_prompt",
      timestamp: new Date().toISOString(),
      kind: modal.kind,
      question: modal.question,
      context: modal.context,
      options: modal.options,
      footer: modal.footer,
      fingerprint: modal.fingerprint,
      // A deadline rather than the seconds left, so a re-announce or a late
      // reader still counts down to the same moment.
      autoDenyAt:
        modal.autoDenySec === undefined
          ? undefined
          : new Date(Date.now() + modal.autoDenySec * 1000).toISOString(),
      tmux: this.tmuxName,
    } satisfies StreamEvent);
  }

  /**
   * Announce that the modal is gone. `resumedTurn` tells the session extension
   * which status to fall back to: answering a hook confirmation mid-turn puts
   * the session back to `running`, while clearing a trust dialog at launch
   * leaves it `idle`. `superseded` means another modal took its place, so the
   * session is still blocked and its status should not move.
   */
  private clearModal(reason: ClearReason, answered?: string): void {
    const modal = this._modal;
    if (!modal) return;
    this._modal = null;
    this.emitModalCleared(modal.fingerprint, reason, answered);
  }

  private emitModalCleared(fingerprint: string, reason: ClearReason, answered?: string): void {
    log.info("modal prompt cleared", {
      id: this.id.slice(0, 8),
      reason,
      answered,
      fingerprint,
    });
    this.emit("sse", {
      type: "modal_prompt_cleared",
      timestamp: new Date().toISOString(),
      reason,
      answered,
      fingerprint,
      resumedTurn: this._turnActive,
    } satisfies StreamEvent);
  }

  /** The prompt currently on screen, if any: a hook request first, else a scraped modal. */
  get modalPrompt(): ModalPrompt | null {
    return this.permissions.current ?? this._modal;
  }

  /**
   * A permission request from the hook. Resolves with the hook's reply
   * once it is answered from Anima, or with no decision when the prompt is
   * settled some other way. A scraped card for the same dialog gives way to it.
   */
  requestPermission(input: PermissionRequestInput, signal?: AbortSignal): Promise<HookReply> {
    if (!this.isActive) return Promise.resolve({ decision: null });
    log.info("permission request from hook", {
      id: this.id.slice(0, 8),
      tool: input.toolName,
      mode: input.permissionMode,
      requestId: input.requestId.slice(0, 8),
    });
    if (input.permissionMode !== "auto" && this._modal) this.clearModal("superseded");
    return this.permissions.request(input, signal);
  }

  /**
   * Answer the modal on screen by pressing one of its option keys.
   *
   * This is not blind key injection: the key must be an option of a modal we can
   * *currently* see, re-captured at call time rather than trusted from the last
   * poll — the prompt may have been answered in an attached pane since. The
   * fingerprint check makes the answer idempotent across two clients racing on
   * the same prompt: the second one finds a different (or no) modal and refuses.
   */
  async answerModal(key: string, fingerprint?: string): Promise<{ ok: boolean; error?: string }> {
    const viaHook = this.permissions.answer(key, fingerprint);
    if (viaHook) {
      log.info("answered permission request via hook", {
        id: this.id.slice(0, 8),
        key,
        ok: viaHook.ok,
        error: viaHook.error,
      });
      return viaHook;
    }
    const live = detectModalPrompt(capturePane(this.tmuxName));
    if (!live) {
      this.clearModal("dismissed");
      return { ok: false, error: "No modal prompt on screen" };
    }
    if (fingerprint && fingerprint !== live.fingerprint) {
      this.setModal(live);
      return { ok: false, error: "The prompt on screen has changed — re-read it before answering" };
    }
    if (!live.options.some((opt) => opt.key === key)) {
      return { ok: false, error: `"${key}" is not one of this prompt's options` };
    }

    log.info("answering modal prompt", {
      id: this.id.slice(0, 8),
      key,
      question: live.question.slice(0, 120),
    });
    this._modal = live;
    sendKey(this.tmuxName, key);

    // Confirm it actually cleared. A modal that survives its own answer is the
    // failure worth reporting — silently claiming success would put the session
    // back to `running` while it sits blocked.
    const deadline = Date.now() + MODAL_CLEAR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, MODAL_CLEAR_SAMPLE_MS));
      const still = detectModalPrompt(capturePane(this.tmuxName));
      if (still?.fingerprint === live.fingerprint) continue;
      this.clearModal("answered", key);
      // Answering one modal can raise the next one (trust → login, or a second
      // hook on the same turn). Surface it immediately rather than at the next
      // poll, so the UI never shows a gap.
      if (still) this.setModal(still);
      return { ok: true };
    }
    log.warn("modal still present after answering", {
      id: this.id.slice(0, 8),
      key,
      paneTail: this.paneTail(8),
    });
    return { ok: false, error: "The prompt is still on screen after answering" };
  }

  /**
   * Paste `text`, submit (Enter), then confirm the CLI accepted it. The send is
   * confirmed by EITHER signal, whichever lands first:
   *   - SSE `message_start` — a fresh agent turn began (idle pane, or a steer the
   *     CLI promoted to a new turn).
   *   - JSONL receipt (`prompt_received`) — the CLI recorded the prompt as a
   *     `user` entry or an `enqueue`. This is the ONLY signal for an in-tool
   *     steer, which the CLI injects at the next tool boundary with no
   *     `message_start` of its own.
   *
   * We never pane-scrape for `[Pasted text #N]` — large pastes consume the
   * placeholder before we can poll. On timeout, surface `submit_failed`; no
   * destructive recovery — the caller (or `/restart`) decides next steps.
   */
  private async pasteSubmitAndConfirm(text: string): Promise<boolean> {
    const wait = this.waitForSendConfirm(TURN_START_TIMEOUT_MS);
    pasteText(this.tmuxName, text);
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
    submit(this.tmuxName);
    if (await wait) return true;

    log.error("no send receipt after submit — aborting (no blind recovery)", {
      ...this.stateSnapshot(),
      paneTail: this.paneTail(10),
    });
    const hint =
      "Claude neither started a turn nor recorded the prompt — the CLI may be on a modal prompt, busy, or stuck. " +
      `Attach with \`tmux attach -t ${this.tmuxName}\` to check, or send \`/restart\` to relaunch.`;
    this.emit("sse", {
      type: "runtime_error",
      subtype: "submit_failed",
      timestamp: new Date().toISOString(),
      reason: "no_receipt",
      message: `Your prompt didn't reach Claude (no receipt in ${Math.round(TURN_START_TIMEOUT_MS / 1000)}s). ${hint}`,
      paneTail: this.paneTail(10),
      hint,
    } satisfies StreamEvent);
    return false;
  }

  /**
   * Resolve true when the CLI confirms the just-submitted prompt — on the first
   * of `turn_started` (SSE `message_start`) or `prompt_received` (JSONL `user` /
   * `enqueue`) — or false on timeout. Subscribe BEFORE pasting so a fast receipt
   * is never missed.
   */
  private waitForSendConfirm(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.off("turn_started", done);
        this.off("prompt_received", done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off("turn_started", done);
        this.off("prompt_received", done);
        resolve(false);
      }, timeoutMs);
      this.once("turn_started", done);
      this.once("prompt_received", done);
    });
  }

  /** Force-relaunch the CLI in a fresh tmux pane — recovery from a wedged TUI. */
  private async handleRestartCommand(): Promise<void> {
    log.info("/restart received — tearing down and relaunching", this.stateSnapshot());
    killSession(this.tmuxName);
    // Don't tear down the proxy — it survives across CLI restarts on the same
    // deterministic port, and the new claude process inherits the same env.
    this._launched = true; // force --resume on relaunch, not --session-id
    this._isClosed = false;
    await this.ensureRunning();
    this._isStarted = true;
    this.lastActivityTime = Date.now();
    log.info("/restart complete", this.stateSnapshot());
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "restarted",
    } satisfies StreamEvent);
    this.endTurn();
  }

  interrupt(): void {
    if (!this._isStarted) return;
    sendKey(this.tmuxName, "Escape");
    this.abortTurn("escape");
  }

  /**
   * Abort the in-flight turn — the single funnel for both interrupt paths:
   * web-UI Escape (via interrupt(), after send-keys) and a direct-tmux Escape
   * (via the JSONL `[Request interrupted by user…]` marker the tail detects).
   *
   * The TUI/SDK does NOT cancel the upstream request on Escape — it stops
   * rendering and ignores further events, letting the stream finish server-side
   * (verified: ~33s of deltas kept arriving after the marker). So we record the
   * in-flight reqId in `_suppressedReqIds` and drop its remaining SSE, otherwise
   * those trailing deltas would "un-stop" the UI after our turn_stop.
   *
   * Idempotent: `endTurn()` clears `_turnActive`, so the second caller (whichever
   * of the two paths fires later) no-ops — exactly one turn_stop{abort} per turn.
   */
  private abortTurn(source: string): void {
    // Someone pressed Escape: they're at the session, so no nudge goes behind them.
    this.endNudgeStreak("interrupt");
    if (!this._turnActive) return;
    if (this._activeReqId) this._suppressedReqIds.add(this._activeReqId);
    log.info("turn aborted — suppressing post-interrupt drain", {
      id: this.id.slice(0, 8),
      source,
      reqId: this._activeReqId,
    });
    this.emit("sse", {
      type: "turn_stop",
      timestamp: new Date().toISOString(),
      stop_reason: "abort",
    } satisfies StreamEvent);
    this.endTurn();
    this.emit("interrupted");
  }

  /**
   * Claude Code gave up on an API failure: the JSONL give-up entry.
   *
   * The cut stream never delivers a `message_stop`, so this entry is the only
   * end the turn will get: without closing it here, the row sits on `running`
   * forever. Then either schedule a nudge, or mark the session stalled.
   */
  private handleApiError(info: ApiErrorInfo, timestamp?: string, recovered = false): void {
    const at = timestamp ? Date.parse(timestamp) : NaN;
    // A live error supersedes one recovered from history.
    if (!recovered) this._recoveredError = null;
    if (
      !recovered &&
      Number.isFinite(at) &&
      at < this._tailStartedAt - API_ERROR_HISTORY_SLACK_MS
    ) {
      log.info("Ignoring an API error from transcript history", {
        id: shortId(this.id),
        timestamp,
      });
      return;
    }
    const retryable = isRetryableApiError(info);
    if (retryable) sharedNudgeBreaker.recordError(this.id);

    const decision = decideOnApiError(this._nudgeStreak, info);
    log.warn("API error ended the turn", {
      id: shortId(this.id),
      error: info.error,
      apiError: info.apiError,
      streamCutCause: info.streamCutCause,
      text: info.text.slice(0, 160),
      decision: decision.action,
      attempt: decision.action === "nudge" ? decision.attempt : decision.attempts,
      recovered,
    });

    // Close the turn first. `turn_stop` writes `completed`, so a stalled
    // status announced before it would be overwritten one event later.
    if (this._turnActive || !this._turnStateKnown) {
      this.emit("sse", {
        type: "turn_stop",
        timestamp: new Date().toISOString(),
        stop_reason: "api_error",
      } satisfies StreamEvent);
    }
    this._turnStateKnown = true;
    this.endTurn();

    if (decision.action === "give_up") {
      this.giveUpNudging(
        decision.reason === "exhausted"
          ? `${info.text} Still failing after ${MAX_NUDGES} nudges, so Anima stopped retrying.`
          : `${info.text} A retry can't fix this kind of failure, so Anima won't nudge it.`,
        info,
      );
      return;
    }

    this._nudgeStreak = decision.streak;
    this._nudgeDefers = 0;
    const delayMs =
      recovered && Number.isFinite(at)
        ? recoveredDelayMs(decision.delayMs, at, Date.now())
        : decision.delayMs;
    this.scheduleNudge(delayMs);
    this.emit("sse", {
      type: "api_error",
      timestamp: new Date().toISOString(),
      status: 0,
      error: info.error,
      apiError: info.apiError,
      message: `${info.text} Anima will ask it to continue in ${formatDelay(delayMs)} (nudge ${decision.attempt} of ${MAX_NUDGES}).`,
      nudge: { attempt: decision.attempt, of: MAX_NUDGES, inMs: delayMs },
    } satisfies StreamEvent);
  }

  private scheduleNudge(delayMs: number): void {
    if (this._nudgeTimer) clearTimeout(this._nudgeTimer);
    this._nudgeTimer = setTimeout(() => void this.fireNudge(), delayMs);
    this._nudgeTimer.unref?.();
  }

  /**
   * The nudge itself, after its backoff. Every check re-reads the live pane:
   * the session may have moved on, someone may be typing in an attached pane,
   * or the whole host may be offline.
   */
  private async fireNudge(): Promise<void> {
    this._nudgeTimer = null;
    const streak = this._nudgeStreak;
    if (!streak || this._isClosed || !this._isStarted) return;

    const slot = sharedNudgeBreaker.acquire();
    if (!slot.ok) {
      log.info("Nudge held by the host-wide breaker", {
        id: shortId(this.id),
        waitMs: slot.waitMs,
        breakerOpen: sharedNudgeBreaker.isOpen,
      });
      this.scheduleNudge(slot.waitMs);
      return;
    }

    await liveness.refresh();
    const paneAlive = liveness.tmuxAlive(this.tmuxName);
    const paneStable = paneAlive && (await this.waitForPaneIdle(Date.now() + 3_000));
    // The world may have moved while we waited on the pane.
    if (this._nudgeStreak !== streak || this._isClosed) return;
    const pane = paneAlive ? capturePane(this.tmuxName) : "";
    const gate = checkNudgeReadiness({
      closed: this._isClosed,
      turnActive: this._turnActive,
      modalOnScreen: detectModalPrompt(pane) !== null,
      paneAlive,
      claudeAlive: liveness.claudeAlive(this.id),
      paneStable,
      input: inputBoxState(pane),
    });

    if (!gate.ok) {
      log.info("Nudge not sent", {
        id: shortId(this.id),
        outcome: gate.outcome,
        reason: gate.reason,
        defers: this._nudgeDefers,
      });
      if (gate.outcome === "abandon") {
        this.endNudgeStreak(gate.reason);
      } else if (gate.outcome === "retry_later" && ++this._nudgeDefers <= NUDGE_MAX_DEFERS) {
        this.scheduleNudge(NUDGE_RETRY_MS);
      } else {
        this.giveUpNudging(
          `${streak.lastError.text} Anima couldn't nudge it to continue (${gate.reason}).`,
          streak.lastError,
        );
      }
      return;
    }

    streak.attempts++;
    log.info("Nudging after an API error", {
      id: shortId(this.id),
      attempt: streak.attempts,
      of: MAX_NUDGES,
    });
    // Delivered means the CLI recorded it or started a turn. Our own
    // `prompt()` reports its failures to the chat; we only need the verdict.
    let delivered = false;
    const markDelivered = (): void => {
      delivered = true;
    };
    this.on("prompt_received", markDelivered);
    this.on("turn_started", markDelivered);
    try {
      await this.prompt(nudgeText(streak.lastError));
    } finally {
      this.off("prompt_received", markDelivered);
      this.off("turn_started", markDelivered);
    }
    if (!delivered && this._nudgeStreak === streak) {
      this.giveUpNudging(
        `${streak.lastError.text} Anima's nudge didn't reach the CLI.`,
        streak.lastError,
      );
    }
  }

  /**
   * Stop trying and say so: `api_error` with `stalled: true`, which the session
   * extension turns into the `api_error` runtime status (the banner's
   * "stalled"). The next turn that runs clears it.
   */
  private giveUpNudging(message: string, info: ApiErrorInfo): void {
    log.warn("Marking session stalled after an API error", {
      id: shortId(this.id),
      error: info.error,
      attempts: this._nudgeStreak?.attempts ?? 0,
    });
    this.endNudgeStreak("gave_up");
    this.emit("sse", {
      type: "api_error",
      timestamp: new Date().toISOString(),
      status: 0,
      error: info.error,
      apiError: info.apiError,
      message: `${message} The session is marked stalled until it's prompted again.`,
      stalled: true,
    } satisfies StreamEvent);
  }

  /** Close the streak and cancel any pending nudge. Idempotent. */
  private endNudgeStreak(reason: string): void {
    this._recoveredError = null;
    if (this._nudgeTimer) {
      clearTimeout(this._nudgeTimer);
      this._nudgeTimer = null;
    }
    if (!this._nudgeStreak) return;
    log.info("API-error streak ended", {
      id: shortId(this.id),
      reason,
      attempts: this._nudgeStreak.attempts,
    });
    this._nudgeStreak = null;
    this._nudgeDefers = 0;
  }

  async close(): Promise<void> {
    if (!this._isStarted && !this.proxy) return;
    this._isClosed = true;
    this.tail.stop();
    this.stopModalWatch();
    this.permissions.settleAll("dismissed");
    this.endNudgeStreak("closed");
    killSession(this.tmuxName);
    // Its Bash wrapper goes with it, rather than idling until the orphan reaper.
    killWrapperSessions(this.id);
    liveness.forget(this.id, this.tmuxName);
    // Its background work died with the pane.
    this.resetBackground();
    this.proxy?.stop();
    this.proxy = null;
    this._isStarted = false;
    this.emit("closed");
    log.info("Closed", { id: this.id.slice(0, 8) });
  }

  /**
   * Graceful-shutdown variant: drop our in-process state but DON'T kill the
   * tmux pane or claude process. The next agent-host's `restorePersistedSessions`
   * will call `start()` → `ensureRunning()` → reuse=true (no respawn, no
   * startup probes, no rate-limit risk). The 10-min idle reaper still kills
   * truly idle CLIs via `close()` so this isn't a resource leak.
   */
  async release(): Promise<RuntimeDrain | void> {
    if (!this._isStarted && !this.proxy) return;
    this._isClosed = true;
    this.tail.stop();
    this.stopModalWatch();
    // The pane and its dialog outlive us: hooks re-ask the next agent-host,
    // which re-announces the same cards.
    this.permissions.settleAll("superseded", { decision: null, retry: true });
    this.endNudgeStreak("closed");
    // Drain, don't stop: a response streaming through the proxy finishes
    // instead of being cut, and the port is free for the next agent-host now.
    const drain = this.proxy?.drain();
    this.proxy = null;
    this._isStarted = false;
    this._turnStateKnown = false;
    this.emit("closed");
    log.info("Released (tmux pane preserved)", {
      id: this.id.slice(0, 8),
      tmux: this.tmuxName,
      inFlight: drain?.inFlight ?? 0,
    });
    return drain;
  }

  setPermissionMode(_mode: string): void {
    // No-op: the CLI runs with --dangerously-skip-permissions.
  }

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {
    // No-op: the CLI executes its own tools.
  }

  get isActive(): boolean {
    return this._isStarted && !this._isClosed;
  }

  /** Read from the shared liveness snapshot: no subprocess, safe on hot paths. */
  get isProcessRunning(): boolean {
    return this.proxy !== null && this.runtimeAlive();
  }

  /** Pane and `claude` both alive, per the latest liveness snapshot. */
  private runtimeAlive(): boolean {
    return liveness.tmuxAlive(this.tmuxName) && liveness.claudeAlive(this.id);
  }

  getInfo(): AgentRuntimeSessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      // The variant-carrying id, not the bare one: `getSessionRecords()` feeds
      // this straight into ~/.anima/agent-host/sessions.json, and restore
      // resumes with whatever it finds. Reporting the sanitized id silently
      // dropped `[1m]` on every agent-host restart, downgrading live 1M
      // sessions to the 200K window. Every consumer compares through
      // `sameModel()`, which strips the suffix anyway, so carrying it is free.
      model: this.cliModel,
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivity: new Date(this.lastActivityTime).toISOString(),
      healthy: this.isActive,
      stale: Date.now() - this.lastActivityTime >= STALE_MS,
      turnActive: reportedTurnActive(this._turnStateKnown, this._turnActive),
      backgroundTasks: this.backgroundTaskCount(),
    };
  }

  /**
   * How many background items this session's `claude` is running or has
   * scheduled: the Stop hook's last snapshot plus the transcript since. None
   * when `claude` isn't running, since they die with it.
   */
  private backgroundTaskCount(): number | undefined {
    if (!this.backgroundSnapshot) return undefined;
    if (!this.isProcessRunning) return 0;
    const snapshot = this.backgroundSnapshot.reader.readIfChanged();
    if (snapshot) this.background.setSnapshot(snapshot);
    return this.background.open().length;
  }

  /** Forget all background work: `claude` is about to be (re)launched. */
  private resetBackground(): void {
    this.background.clear();
    if (!this.backgroundSnapshot) return;
    try {
      removeBackgroundSnapshot(this.backgroundSnapshot.path);
    } catch (err) {
      log.warn("Couldn't remove the background snapshot", {
        id: shortId(this.id),
        error: String(err),
      });
    }
    this.backgroundSnapshot.reader.reset();
  }

  /** Feed the transcript's last stretch (before the tail began) to the ledger. */
  private replayBackgroundHistory(): void {
    try {
      for (const line of this.tail.historyLines()) {
        const record = parseEntry(line);
        if (record) this.background.apply(backgroundChanges(record), entryTime(record));
      }
    } catch (err) {
      log.warn("Couldn't read the transcript for background work", {
        id: shortId(this.id),
        error: String(err),
      });
    }
  }

  private endTurn(): void {
    this._emittedToolResultIds.clear();
    // A finished turn has nothing left to approve.
    this.permissions.settleAll("dismissed");
    if (this._turnActive) {
      this._turnActive = false;
      this.emit("process_ended");
    }
  }

  private handleProxyEvent(event: StreamEvent, ctx: StreamContext): void {
    // A released session's proxy can still be draining a response. The
    // pane belongs to the next agent-host now, so the rest of that stream must
    // not move this instance's turn state or reach its listeners.
    if (this._isClosed) return;
    // Drop auxiliary streams (title-gen, quota probe, topic detection) so they
    // never reach the chat — only real agent turns carry the toolset.
    if (!ctx.isAgentTurn) return;

    // Post-interrupt drain: an interrupted request finishes server-side even
    // though the TUI stopped. Drop its remainder so the UI doesn't un-stop on
    // trailing deltas; the terminating message_stop retires the reqId.
    if (this._suppressedReqIds.has(ctx.reqId)) {
      if (event.type === "message_stop") this._suppressedReqIds.delete(ctx.reqId);
      return;
    }

    // Any agent-turn event proves we have a live read on the TUI's turn state;
    // future prompts can trust `_turnActive` without re-running pane-idle.
    //
    // It also proves a turn is in flight *now*, which is a separate fact and
    // was being dropped. `_turnActive` was set only by `submitPrompt`, so a
    // session adopted or resumed mid-turn streamed a whole turn's events while
    // reporting no turn — and once the line above flipped the state to
    // "known", that false reading became one other code was entitled to
    // believe. An arriving agent event is the more reliable of the two
    // signals: it is the turn, rather than a memory of having started one.
    this._turnStateKnown = true;
    // Announce the opening edge, don't just record it. `endTurn` already emits
    // `process_ended` for the closing one, so this is its missing partner —
    // and without it a session adopted or resumed mid-turn had no way to say
    // it was working until something else went looking, which meant a periodic
    // sweep and a window of up to a minute showing the wrong thing. A stream
    // event is the earliest honest moment to know.
    if (!this._turnActive) {
      this._turnActive = true;
      this.emit("process_started");
    }
    this.lastActivityTime = Date.now();
    this._activeReqId = ctx.reqId;
    const type = event.type;

    if (type === "message_delta") {
      const sr = (event as { delta?: { stop_reason?: string } }).delta?.stop_reason;
      if (sr) this.lastStopReason = sr;
    }

    // `message_start` = Claude began processing a new agent turn. This is the
    // source-of-truth signal that a freshly-submitted prompt landed — the
    // paste flow waits on it instead of pane-scraping for the placeholder.
    if (type === "message_start") {
      this.emit("turn_started");
    }

    this.emit("sse", event);

    if (type === "message_stop") {
      const terminal = TERMINAL_STOP.has(this.lastStopReason);
      // The one decision that determines whether a spinner ever stops, and
      // until now it left no trace. A turn that ends without `turn_stop` looks
      // identical from outside to a turn still running — same symptom the
      // "No tool results in request tail" warning below exists to explain.
      // Logged either way: knowing the reason was `tool_use` (mid-turn, so
      // correct) is what rules the path out when it isn't the culprit.
      log.info("message_stop", {
        id: shortId(this.id),
        stopReason: this.lastStopReason || "(none seen)",
        terminal,
        reqId: ctx.reqId,
      });
      if (terminal) {
        this.emit("sse", {
          type: "turn_stop",
          timestamp: new Date().toISOString(),
          stop_reason: this.lastStopReason,
        } satisfies StreamEvent);
        this.endTurn();
        // A turn that finished is the streak's happy ending (the nudge worked).
        this.endNudgeStreak("turn_completed");
      }
    }
  }

  /** Surface tool_result blocks the CLI sends in its continuation request. */
  private handleRequestBody(body: unknown, ctx: StreamContext): void {
    if (!ctx.isAgentTurn) return;
    if (!body || typeof body !== "object") return;
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Drop results we already surfaced. The trailing-run scan below is
    // self-limiting across turns (an assistant message ends the run), but the
    // CLI re-sends an identical body when it retries a request — without this,
    // a 429 would replay every tool result in the current batch.
    const found = collectTrailingToolResults(messages);
    const fresh = found.filter((result) => {
      const id = result.tool_use_id;
      if (typeof id !== "string") return true;
      if (this._emittedToolResultIds.has(id)) return false;
      this._emittedToolResultIds.add(id);
      return true;
    });

    // This reconstruction is a heuristic over a message shape the CLI controls
    // and has changed underneath us before (a trailing `system` reminder is
    // what stranded every spinner). When it finds nothing, say so and describe
    // the tail — otherwise the only symptom is a spinner that never stops, with
    // nothing in the logs to explain it.
    if (found.length === 0) {
      log.warn("No tool results in request tail — spinners may not clear", {
        messageCount: messages.length,
        tailRoles: messages
          .slice(-4)
          .map((m) => (m as { role?: string } | null)?.role ?? "?")
          .join(","),
        tailBlockTypes: messages
          .slice(-4)
          .map((m) => {
            const content = (m as { content?: unknown } | null)?.content;
            return Array.isArray(content)
              ? `[${content.map((b) => (b as { type?: string })?.type ?? "?").join("|")}]`
              : typeof content;
          })
          .join(","),
      });
      return;
    }

    log.info("Surfaced tool results", {
      found: found.length,
      fresh: fresh.length,
      messageCount: messages.length,
    });
    if (fresh.length === 0) return;

    this.emit("sse", {
      type: "request_tool_results",
      timestamp: new Date().toISOString(),
      tool_results: fresh,
    } satisfies StreamEvent);
  }
}

/** "30s", "2m", "10m": the nudge delays in the chat's own words. */
function formatDelay(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/**
 * What this session may claim about having a turn in flight.
 *
 * Only when we actually have a live read on the TUI. A fresh instance — and
 * every resume across a restart — clears `_turnStateKnown` precisely because
 * `_turnActive` is stale at that moment: the flag reads false while a turn we
 * never saw start is still running. Reporting that as "no turn" tells the
 * session reconciler to retire a status mid-turn, which stops the spinner on a
 * session that is very much working. `undefined` means "no opinion", and the
 * reconciler leaves such a row alone.
 */
export function reportedTurnActive(known: boolean, active: boolean): boolean | undefined {
  return known ? active : undefined;
}

export function createClaudeCliProvider(config: ClaudeCliProviderConfig = {}) {
  return {
    create: (options: CreateSessionOptions): ClaudeCliSession =>
      new ClaudeCliSession(options.sessionId || randomUUID(), options, false, config),
    resume: (sessionId: string, options: ResumeSessionOptions): ClaudeCliSession =>
      new ClaudeCliSession(sessionId, options, true, config),
  };
}
