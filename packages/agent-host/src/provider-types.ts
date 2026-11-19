import type { HookReply, PermissionRequestInput } from "./providers/cli/permission-requests";
import type { ThinkingEffort } from "@anima/shared";
import type { ResolvedProfile } from "./profiles";

/** Emitted runtime event. Anthropic events use native SSE event names; other
 * providers should normalize their stream to the same high-level shape. */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface CreateSessionOptions {
  /** Optional caller-supplied session ID */
  sessionId?: string;
  /** Working directory for the provider runtime */
  cwd: string;
  /** Model to use */
  model?: string;
  /** System prompt or instructions */
  systemPrompt?: string;
  /** Enable adaptive thinking, when supported */
  thinking?: boolean;
  /** Thinking effort level, when supported */
  effort?: ThinkingEffort;
  /** Runtime sandbox mode, when supported */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Permission profile, resolved by SessionHost (which always supplies one).
   * Providers that support profiles fall back to `yolo` only when called
   * directly, as tests do.
   */
  profile?: ResolvedProfile;
}

export interface ResumeSessionOptions {
  /** Working directory for the provider runtime */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Last observed activity timestamp (ISO) for restore hydration */
  lastActivity?: string;
  /** Enable adaptive thinking, when supported */
  thinking?: boolean;
  /** Thinking effort level, when supported */
  effort?: ThinkingEffort;
  /** Runtime sandbox mode, when supported */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Permission profile; see CreateSessionOptions.profile. */
  profile?: ResolvedProfile;
}

export interface AgentRuntimeSessionInfo {
  id: string;
  cwd: string;
  model: string;
  isActive: boolean;
  isProcessRunning: boolean;
  createdAt: string;
  lastActivity: string;
  healthy: boolean;
  stale: boolean;
  /**
   * Whether a turn is in flight *right now*.
   *
   * The ground truth behind `runtime_status`, which is a persisted cache of a
   * live fact and therefore wrong the moment its writer dies mid-turn. A
   * process being alive doesn't answer this — a session can be running and
   * idle — so `isProcessRunning` was never enough to correct a row stuck on
   * `running`. Optional because a provider that can't know its own turn state
   * should say nothing rather than guess: absent means "no opinion", and the
   * reconcile leaves such a row alone.
   */
  turnActive?: boolean;
  /**
   * Background work the session is waiting on between turns: Monitors,
   * background shells and subagents, crons, `/loop` wakeups. Absent when the
   * provider can't tell. Closers leave a session with any alone
   * (`heldByBackgroundWork` in `@anima/shared`).
   */
  backgroundTasks?: number;
}

/** Responses still streaming through a released runtime. */
export interface RuntimeDrain {
  /** Requests in flight when the listeners closed. */
  inFlight: number;
  /** Settles when the last of them has finished. Never rejects. */
  done: Promise<void>;
}

export interface AgentRuntimeSession {
  readonly id: string;
  readonly isActive: boolean;
  readonly isProcessRunning: boolean;
  start(): Promise<void>;
  prompt(content: string | unknown[]): Promise<void> | void;
  interrupt(): void;
  close(): Promise<void>;
  /**
   * Optional graceful-shutdown variant. Releases in-process resources but may
   * preserve out-of-process runtime so a fresh agent-host can reuse it (CLI mode
   * leaves the tmux pane + claude alive — `--resume` picks back up with no
   * startup probes). Falls back to `close()` when omitted.
   *
   * Returns a drain when responses were still streaming through the runtime at
   * release: its listeners are already closed, so a new agent-host can
   * take the ports, and `done` settles once those responses finish.
   */
  release?(): Promise<RuntimeDrain | void>;
  /**
   * Answer a modal prompt the runtime is blocked on by pressing one of its
   * option keys. Optional: only the CLI runtime drives a real TUI that can
   * stop on a modal — the SDK providers surface permissions as tool calls.
   *
   * `fingerprint` scopes the answer to the prompt the caller actually saw, so a
   * stale click from a tab that has been open a while can't answer a *different*
   * question than the one it rendered.
   */
  answerModal?(key: string, fingerprint?: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * A permission request from Claude Code's `PermissionRequest` hook,
   * resolved with the hook's reply. Optional: only the CLI runtime has the hook.
   */
  requestPermission?(input: PermissionRequestInput, signal?: AbortSignal): Promise<HookReply>;
  setPermissionMode(mode: string): void;
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void;
  getInfo(): AgentRuntimeSessionInfo;
  on(eventName: "sse", listener: (event: StreamEvent) => void): this;
  on(eventName: "process_started" | "process_ended" | "closed", listener: () => void): this;
}

export type AgentRuntimeFactory = {
  create: (options: CreateSessionOptions) => AgentRuntimeSession;
  resume: (sessionId: string, options: ResumeSessionOptions) => AgentRuntimeSession;
};

export type AgentRuntimeProviders = Record<string, AgentRuntimeFactory>;
