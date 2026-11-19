import { animaLogFile, createLogger, shortId } from "@anima/shared";
import {
  LEGACY_SESSION_PROFILE,
  getSessionProfile,
  setSessionProfile,
  updateSessionMetadata,
  updateSessionRuntime,
  type RuntimeStatus,
} from "../session-store";
import { applyRuntimeStatus, emitListChanged, reopenForPrompt } from "../session-status-events";
import { resolveSessionPath } from "../parse-session";
import { formatMemoryContext, type MemoryContextResult } from "../memory-context";
import {
  type AgentHostSessionInfo,
  promptText,
  type RequestContext,
  summarizePrompt,
} from "../session-types";
import { deriveTitleFromMessage } from "../session-title";
import { waitForWorktree } from "./worktree-session";
import { callMemory } from "./memory-calls";
import { markSubagentRunning } from "./subagent-workflow";
import { getRuntime } from "../runtime";
import { sameModel } from "../model-id";
import {
  buildElapsedTimeReminder,
  buildSessionStartReminder,
  withTimeReminder,
} from "./time-context";

const log = createLogger("SessionExt:Prompt", animaLogFile("session.log"));

const MEMORY_TRANSITION_TIMEOUT_MS = 1500;
const MEMORY_CONTEXT_TIMEOUT_MS = 2000;

// ── Types ────────────────────────────────────────────────────

type SessionEventListener = (event: {
  sessionId: string;
  type?: string;
  eventName?: string;
}) => void;

interface StoredSessionLike {
  workspaceId: string;
  model: string;
  agent: string;
  purpose: "chat" | "subagent" | "review" | "test";
  parentSessionId: string | null;
  runtimeStatus: RuntimeStatus;
  title?: string | null;
  metadata: Record<string, unknown> | null;
}

interface WorkspaceInfoLike {
  id: string;
  cwd: string;
  general: boolean;
}

interface WorkspaceResultLike {
  workspace: WorkspaceInfoLike;
  created: boolean;
}

interface SessionBootstrapMetadata extends Record<string, unknown> {
  bootstrapSystemPrompt?: string;
  bootstrapThinking?: boolean;
  bootstrapEffort?: "low" | "medium" | "high" | "max";
}

export interface PromptLifecycleInput {
  sessionId: string;
  content: string | unknown[];
  cwd?: string;
  model?: string;
  agent: string;
  streaming: boolean;
  source?: string;
}

// ── Internal state ───────────────────────────────────────────

interface PromptLifecycleState {
  sessionId: string;
  content: string | unknown[];
  effectiveCwd?: string;
  resolvedModel: string;
  agent: string;
  streaming: boolean;
  source?: string;
  existing: StoredSessionLike | null;
  existingMetadata: SessionBootstrapMetadata | null;
  workspaceResult?: WorkspaceResultLike;
  requestContext?: RequestContext;
  userMessageAtIso?: string;
}

// ── Helpers ─────────────────────────────────────────────────

async function transitionConversation(cwd: string): Promise<void> {
  const rt = getRuntime();
  await callMemory({
    call: (method, params) => rt.ctx.call(method, params),
    method: "memory.transition_conversation",
    params: { cwd },
    timeoutMs: MEMORY_TRANSITION_TIMEOUT_MS,
    log,
    failure: "Failed to transition previous conversations (non-fatal)",
    meta: { cwd },
  });
}

async function buildBootstrapSystemPrompt(params: {
  cwd: string;
  baseSystemPrompt?: string;
  includeAllSummaries: boolean;
}): Promise<string | undefined> {
  const rt = getRuntime();
  const { cwd, baseSystemPrompt, includeAllSummaries } = params;
  let systemPrompt = baseSystemPrompt
    ? `${baseSystemPrompt}\n\n${buildSessionStartReminder()}`
    : buildSessionStartReminder();

  await transitionConversation(cwd);

  const memoryContext = (await callMemory({
    call: (method, params) => rt.ctx.call(method, params),
    method: "memory.get_session_context",
    params: { cwd, includeAllSummaries },
    timeoutMs: MEMORY_CONTEXT_TIMEOUT_MS,
    log,
    failure: "Failed to inject memory context (non-fatal)",
  })) as MemoryContextResult | null;

  try {
    const memoryBlock = memoryContext ? formatMemoryContext(memoryContext) : null;
    if (memoryContext && memoryBlock) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryBlock}` : memoryBlock;
      log.info("Injected memory context into session bootstrap", {
        recentMessages: memoryContext.recentMessages.length,
        recentSummaries: memoryContext.recentSummaries.length,
      });
    }
  } catch (err) {
    log.warn("Failed to inject memory context (non-fatal)", { error: String(err) });
  }

  return systemPrompt;
}

async function ensureSessionBootstrapped(params: {
  sessionId: string;
  cwd: string;
  workspaceId: string;
  agent: string;
  model: string;
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  baseSystemPrompt?: string;
  includeAllSummaries: boolean;
  purpose?: "chat" | "subagent" | "review" | "test";
  parentSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const rt = getRuntime();
  if (resolveSessionPath(params.sessionId, params.cwd)) return;

  const systemPrompt = await buildBootstrapSystemPrompt({
    cwd: params.cwd,
    baseSystemPrompt: params.baseSystemPrompt,
    includeAllSummaries: params.includeAllSummaries,
  });

  // A session created implicitly by its first prompt has no row yet; those
  // come from the user's own clients, so they get the legacy (yolo) profile.
  const profile = getSessionProfile(params.sessionId) ?? LEGACY_SESSION_PROFILE;
  await rt.bridge.createSession({
    sessionId: params.sessionId,
    cwd: params.cwd,
    agent: params.agent,
    model: params.model,
    systemPrompt,
    thinking: params.thinking,
    effort: params.effort,
    profile,
  });

  rt.registry.upsertSession({
    id: params.sessionId,
    workspaceId: params.workspaceId,
    providerSessionId: params.sessionId,
    model: params.model,
    agent: params.agent,
    purpose: params.purpose || "chat",
    parentSessionId: params.parentSessionId,
    cwd: params.cwd,
    runtimeStatus: "idle",
    metadata: {
      ...(params.metadata || {}),
      bootstrapSystemPrompt: params.baseSystemPrompt,
      bootstrapThinking: params.thinking,
      bootstrapEffort: params.effort,
    },
  });
  setSessionProfile(params.sessionId, profile);
  log.info("Session bootstrapped", { sessionId: shortId(params.sessionId), cwd: params.cwd });
}

// ── Pipeline stages ──────────────────────────────────────────

function getBootstrapSettings(state: PromptLifecycleState): {
  thinking: boolean;
  effort: "low" | "medium" | "high" | "max";
  baseSystemPrompt?: string;
} {
  const rt = getRuntime();
  const metadata = state.existingMetadata;
  return {
    thinking:
      typeof metadata?.bootstrapThinking === "boolean"
        ? metadata.bootstrapThinking
        : rt.sessionConfig.thinking,
    effort:
      metadata?.bootstrapEffort === "low" ||
      metadata?.bootstrapEffort === "medium" ||
      metadata?.bootstrapEffort === "high" ||
      metadata?.bootstrapEffort === "max"
        ? metadata.bootstrapEffort
        : rt.sessionConfig.effort,
    baseSystemPrompt:
      typeof metadata?.bootstrapSystemPrompt === "string"
        ? metadata.bootstrapSystemPrompt
        : rt.sessionConfig.systemPrompt || undefined,
  };
}

async function resolveSessionStage(input: PromptLifecycleInput): Promise<PromptLifecycleState> {
  const rt = getRuntime();
  const sessionId = input.sessionId;

  log.info("Sending prompt", {
    agent: input.agent,
    sessionId: shortId(sessionId),
    streaming: input.streaming,
    source: input.source || "web",
    content: summarizePrompt(input.content),
  });

  // A session whose worktree is still being made has no folder to run in yet.
  // Read the row only after: a project's bootstrap may have moved its cwd.
  await waitForWorktree(sessionId, (id) => rt.registry.getStoredSession(id)?.metadata, {
    prompt: {
      content: input.content,
      ...(input.model ? { model: input.model } : {}),
      agent: input.agent,
      ...(input.source ? { source: input.source } : {}),
      queuedAt: new Date().toISOString(),
    },
    patchMetadata: (id, patch) => void updateSessionMetadata(id, patch),
  });

  const existing = rt.registry.getStoredSession(sessionId);
  // An existing session runs where it always has: Claude Code resumes a
  // transcript only from the folder that holds it. The client's cwd is the
  // workspace it is showing, which for a worktree session is the root.
  let effectiveCwd = existing?.cwd ?? input.cwd;
  let workspaceResult =
    effectiveCwd !== undefined ? rt.registry.getOrCreateWorkspace(effectiveCwd) : undefined;
  if (!effectiveCwd && existing) {
    const storedWorkspace = rt.registry.getWorkspace(existing.workspaceId);
    if (storedWorkspace) {
      effectiveCwd = storedWorkspace.cwd;
      workspaceResult = { workspace: storedWorkspace, created: false };
    }
  }

  return {
    sessionId,
    content: input.content,
    effectiveCwd,
    resolvedModel: input.model || existing?.model || rt.sessionConfig.model,
    agent: input.agent,
    streaming: input.streaming,
    source: input.source,
    existing,
    existingMetadata: (existing?.metadata || null) as SessionBootstrapMetadata | null,
    workspaceResult,
  };
}

/**
 * The name a brand-new session should go by, derived from the prompt that
 * started it.
 *
 * `metadata.firstPrompt` is normally written by the reconciler, which reads it
 * back out of the transcript on disk — so it doesn't exist until the turn has
 * produced a file to read, and until then the nav falls back to eight hex
 * digits of session id. That's precisely backwards: the moment a prompt is
 * dispatched is the moment we know most cheaply what the session is about.
 *
 * Written only when there's nothing better. An explicit rename outranks this,
 * and a `firstPrompt` already on the row belongs to an earlier turn — this is
 * the *first* prompt, not the latest one.
 */
export function firstPromptTitle(state: {
  content: string | unknown[];
  existing: { title?: string | null } | null;
  existingMetadata: Record<string, unknown> | null;
}): string | null {
  if (state.existing?.title) return null;
  if (typeof state.existingMetadata?.firstPrompt === "string") return null;
  return deriveTitleFromMessage(promptText(state.content));
}

async function prepareRuntimeStage(state: PromptLifecycleState): Promise<void> {
  const rt = getRuntime();
  state.userMessageAtIso = new Date().toISOString();
  const derivedTitle = firstPromptTitle(state);
  const activeSessions = (await rt.bridge.listSessions()) as AgentHostSessionInfo[];
  const activeSession = activeSessions.find((session) => session.id === state.sessionId);
  if (
    activeSession &&
    activeSession.isProcessRunning &&
    activeSession.model &&
    !sameModel(activeSession.model, state.resolvedModel)
  ) {
    log.warn("Detected model drift; recycling session runtime", {
      sessionId: shortId(state.sessionId),
      runningModel: activeSession.model,
      desiredModel: state.resolvedModel,
    });
    await rt.bridge.closeSession(state.sessionId);
  }

  if (!state.existing && state.effectiveCwd && state.workspaceResult) {
    rt.registry.upsertSession({
      id: state.sessionId,
      workspaceId: state.workspaceResult.workspace.id,
      providerSessionId: state.sessionId,
      model: state.resolvedModel,
      agent: state.agent,
      purpose: "chat",
      cwd: state.effectiveCwd,
      runtimeStatus: "idle",
      metadata: {
        lastUserMessageAt: state.userMessageAtIso,
        ...(derivedTitle ? { firstPrompt: derivedTitle } : {}),
      },
    });
    rt.registry.setWorkspaceActiveSession(state.workspaceResult.workspace.id, state.sessionId);
    // A row that didn't exist a moment ago is a list-membership change, and
    // the tab that caused it isn't the only one that should see it.
    emitListChanged(state.workspaceResult.workspace.id, "session_created");
    return;
  }

  if (state.existing) {
    updateSessionRuntime(state.sessionId, state.existing.runtimeStatus, {
      lastUserMessageAt: state.userMessageAtIso,
      ...(derivedTitle ? { firstPrompt: derivedTitle } : {}),
    });
  }
}

async function bootstrapSessionStage(state: PromptLifecycleState): Promise<void> {
  if (!state.effectiveCwd || !state.workspaceResult) return;
  if (resolveSessionPath(state.sessionId, state.effectiveCwd)) return;

  const bootstrap = getBootstrapSettings(state);
  await ensureSessionBootstrapped({
    sessionId: state.sessionId,
    cwd: state.effectiveCwd,
    workspaceId: state.workspaceResult.workspace.id,
    agent: state.agent,
    model: state.resolvedModel,
    thinking: bootstrap.thinking,
    effort: bootstrap.effort,
    baseSystemPrompt: bootstrap.baseSystemPrompt,
    includeAllSummaries: state.workspaceResult.workspace.general,
    purpose: state.existing?.purpose,
    parentSessionId: state.existing?.parentSessionId,
    metadata: {
      ...(state.existing?.metadata || {}),
      ...(state.userMessageAtIso ? { lastUserMessageAt: state.userMessageAtIso } : {}),
    },
  });
}

function attachRequestContextStage(
  state: PromptLifecycleState,
  request: { connectionId: string | null; tags: string[] | null },
): void {
  const rt = getRuntime();
  const requestContext: RequestContext = {
    connectionId: request.connectionId,
    tags: request.tags,
    source: state.source,
    responseText: "",
  };
  const binding = rt.sessionActors.bindPromptRequest(state.sessionId, requestContext, {
    streaming: state.streaming,
  });
  if (
    binding.preservedPrimaryConnectionId &&
    binding.preservedPrimaryConnectionId !== request.connectionId
  ) {
    log.info("Preserving primary context", {
      sessionId: shortId(state.sessionId),
      primaryConn: binding.preservedPrimaryConnectionId.slice(0, 8),
      transientConn: request.connectionId?.slice(0, 8),
    });
  }
  state.requestContext = requestContext;
}

async function dispatchStreamingPromptStage(
  state: PromptLifecycleState,
): Promise<{ status: "streaming"; sessionId: string }> {
  const rt = getRuntime();
  const promptStart = Date.now();
  const content = withTimeReminder(
    state.content,
    buildElapsedTimeReminder({ metadata: state.existingMetadata }),
  );
  await rt.bridge.prompt(
    state.sessionId,
    content,
    state.effectiveCwd,
    state.resolvedModel,
    state.agent,
  );

  const turnListener: SessionEventListener = (event) => {
    if (event.sessionId !== state.sessionId || event.type !== "turn_stop") return;
    const elapsed = Date.now() - promptStart;
    const responseLen = rt.sessionActors.getResponseTextLength(state.sessionId);
    log.info("Streaming turn complete", {
      sessionId: shortId(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: responseLen,
    });
    rt.bridge.offSessionEvent(turnListener);
  };

  rt.bridge.onSessionEvent(turnListener);
  return { status: "streaming", sessionId: state.sessionId };
}

async function dispatchNonStreamingPromptStage(
  state: PromptLifecycleState,
): Promise<{ text: string; sessionId: string; stopReason: string }> {
  const rt = getRuntime();
  const promptStart = Date.now();
  const turnResultPromise = rt.sessionActors.beginTurn(state.sessionId, 300_000);
  const content = withTimeReminder(
    state.content,
    buildElapsedTimeReminder({ metadata: state.existingMetadata }),
  );

  try {
    await rt.bridge.prompt(
      state.sessionId,
      content,
      state.effectiveCwd,
      state.resolvedModel,
      state.agent,
    );
  } catch (error) {
    rt.sessionActors.failTurn(
      state.sessionId,
      error instanceof Error ? error : new Error(String(error)),
    );
    await turnResultPromise.catch(() => undefined);
    throw error;
  }

  try {
    const result = await turnResultPromise;
    const elapsed = Date.now() - promptStart;
    log.info("Non-streaming prompt complete", {
      sessionId: shortId(state.sessionId),
      elapsed: `${elapsed}ms`,
      responseChars: result.text.length,
      stopReason: result.stopReason,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Prompt timed out after 5 minutes") {
      log.error("Prompt timed out", {
        sessionId: shortId(state.sessionId),
        elapsed: "300s",
      });
    } else if (message.startsWith("Session process died:")) {
      log.error("Non-streaming prompt failed: process died", {
        sessionId: shortId(state.sessionId),
        reason: message.replace("Session process died: ", "") || "unknown",
      });
    }
    throw error;
  }
}

// ── Public API ──────────────────────────────────────────────

export async function runPromptLifecycle(
  input: PromptLifecycleInput,
  request: { connectionId: string | null; tags: string[] | null },
): Promise<{ status: "streaming"; sessionId: string } | { text: string; sessionId: string }> {
  const state = await resolveSessionStage(input);
  await prepareRuntimeStage(state);
  await bootstrapSessionStage(state);
  attachRequestContextStage(state, request);
  // A prompt to a resolved, archived or snoozed session brings it back to the
  // ACTIVE queue, so switching away doesn't lose it in the workspace tree.
  reopenForPrompt(state.sessionId);
  // A turn is now in flight, and that's what `running` has to mean for the nav
  // to be useful. Waiting for agent-host's `process_started` doesn't work: it
  // only fires when a process is actually spawned, so every turn on an already
  // running session went straight from idle to completed and the row never
  // showed as working at all — verified live before this line existed.
  applyRuntimeStatus(state.sessionId, "running");
  // A follow-up prompt to a subagent makes it busy again (no-op for chats).
  markSubagentRunning(state.sessionId);
  try {
    if (state.streaming) {
      return await dispatchStreamingPromptStage(state);
    }
    return await dispatchNonStreamingPromptStage(state);
  } catch (err) {
    // A dispatch that throws never reaches `turn_stop`, so without this the
    // row stays `running` forever — the exact silent abandonment the status
    // axis exists to make visible.
    applyRuntimeStatus(state.sessionId, "failed");
    throw err;
  }
}
