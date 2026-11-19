import {
  animaLogFile,
  createLogger,
  extractBearerToken,
  loadConfig,
  validateToken,
} from "@anima/shared";
import type {
  AnimaConfig,
  AgentHostClientMessage as ClientMessage,
  AgentHostResponseMessage as ResponseMessage,
  AgentHostSessionEventMessage as SessionEventMessage,
} from "@anima/shared";
import {
  SessionHost,
  type SessionCreateParams,
  type SessionDefaults,
  type SessionDrain,
  type SessionRecord,
  type SessionResumeParams,
} from "./session-host";
import { loadState, saveState, type PersistedState } from "./state";
import { awaitDrains } from "./drain";
import { adoptLiveCliSessions, restorePersistedSessions } from "./restore";
import { listTmuxSessions, paneCurrentPath } from "./providers/cli/tmux";
import { liveness as hostLiveness, type LivenessMonitor } from "./providers/cli/liveness";
import type { BufferedEvent } from "./event-buffer";
import type { ThinkingEffort } from "@anima/shared";
import { createAnthropicProvider } from "./providers/anthropic/sdk-session";
import { createCodexProvider } from "./providers/codex/session";
import { createClaudeCliProvider } from "./providers/cli/session";
import { defaultBackgroundDir, writeHookSettings } from "./providers/cli/hook-settings";
import { resolvePersonaFile } from "./persona";
import { configurePanePrefix } from "./pane-names";
import { configureInstanceEnv, instanceSessionEnv } from "./providers/anima-env";
import type { HookReply, PermissionRequestInput } from "./providers/cli/permission-requests";
import {
  PERMISSION_HOOK_PATH,
  parsePermissionHookRequest,
  verifyPermissionHookToken,
} from "./providers/cli/permission-hook";

export interface SessionHostLike {
  on: (eventName: "session.event", listener: (msg: SessionEventMessage) => void) => unknown;
  setDefaults: (defaults: SessionDefaults) => void;
  create: (params: SessionCreateParams) => Promise<{ sessionId: string }>;
  resume: (params: SessionResumeParams) => Promise<{ sessionId: string }>;
  prompt: (
    sessionId: string,
    content: string | unknown[],
    cwd?: string,
    model?: string,
    agent?: string,
  ) => Promise<void> | void;
  interrupt: (sessionId: string) => boolean;
  answerModal: (
    sessionId: string,
    key: string,
    fingerprint?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  requestPermission?: (
    sessionId: string,
    input: PermissionRequestInput,
    signal?: AbortSignal,
  ) => Promise<HookReply>;
  close: (sessionId: string) => Promise<void>;
  setPermissionMode: (sessionId: string, mode: string) => boolean;
  sendToolResult: (
    sessionId: string,
    toolUseId: string,
    content: string,
    isError?: boolean,
  ) => boolean;
  list: () => Array<unknown>;
  count: () => number;
  trackedIds?: () => Set<string>;
  getSessionRecords: () => SessionRecord[];
  getEventsAfter: (sessionId: string, lastSeq: number) => BufferedEvent[];
  closeAll: () => Promise<SessionDrain[]>;
  reapIdleRunningSessions?: (idleMs: number, nowMs?: number) => Promise<string[]>;
}

export interface AgentHostServerOptions {
  port?: number;
  hostname?: string;
  sessionHost?: SessionHostLike;
  loadConfig?: typeof loadConfig;
  loadState?: () => PersistedState;
  saveState?: typeof saveState;
  logger?: ReturnType<typeof createLogger>;
  stateSaveIntervalMs?: number | null;
  /**
   * How startup discovers CLI sessions the registry missed.
   *
   * Injectable because the real implementation shells out to tmux and the
   * process table — a test that got the defaults would inspect, and try to
   * adopt, the developer's own running sessions. Pass `null` to skip adoption
   * entirely.
   */
  adoptDeps?: AdoptDeps | null;
  /**
   * The shared CLI liveness snapshot. Defaults to the host-wide monitor
   * when the Claude runtime is the CLI. Under `bun test` the default is none,
   * so a suite can't probe the developer's real processes by accident.
   */
  liveness?: LivenessMonitor | null;
  livenessIntervalMs?: number;
}

type AdoptDeps = Parameters<typeof adoptLiveCliSessions>[1];

export interface StopOptions {
  /**
   * How long to wait for responses still streaming through released sessions
   * before returning. 0 (default) doesn't wait.
   */
  drainMs?: number;
}

export interface AgentHostServerContext {
  server: ReturnType<typeof Bun.serve>;
  sessionHost: SessionHostLike;
  clients: Map<unknown, WSClient>;
  handleMessage: (ws: unknown, raw: string) => Promise<void>;
  broadcastSessionEvent: (msg: SessionEventMessage) => void;
  stop: (signal?: string, options?: StopOptions) => Promise<void>;
  port: number;
}

interface WSClient {
  ws: unknown; // Bun's ServerWebSocket type
  extensionId: string;
  subscribedSessions: Set<string>;
}

export async function createAgentHostServer(
  options: AgentHostServerOptions = {},
): Promise<AgentHostServerContext> {
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.logger ?? createLogger("AgentHost", animaLogFile("agent-host.log"));
  const loadConfigFn = options.loadConfig ?? loadConfig;
  const loadStateFn = options.loadState ?? loadState;
  const saveStateFn = options.saveState ?? saveState;
  const stateSaveIntervalMs = options.stateSaveIntervalMs ?? 30_000;

  // Load config for session defaults
  const config = loadConfigFn();
  // `agentHost.port` (env ANIMA_AGENT_HOST_PORT), default 30087.
  const port = options.port ?? config.agentHost?.port ?? 30087;
  // Only this instance's panes are adopted and reaped, and its sessions' tools
  // reach its own gateway (both matter when two instances share a machine).
  configurePanePrefix(config.agentHost?.tmuxPrefix);
  configureInstanceEnv(
    instanceSessionEnv({
      gatewayPort: config.gateway.port,
      tmuxPrefix: config.agentHost?.tmuxPrefix ?? "anima",
    }),
  );
  const expectedToken = config.gateway.token;
  const sessionExtConfig = (config.extensions?.session?.config || {}) as Record<string, unknown>;
  const configuredImageProcessing = sessionExtConfig.imageProcessing;
  const configuredSkills = sessionExtConfig.skills;
  const extensionMcpConfig = config.agentHost.extensionMcp ?? {};
  const extensionMcpEnabled = extensionMcpConfig.enabled !== false;
  const extensionMcpUrl =
    typeof extensionMcpConfig.url === "string" && extensionMcpConfig.url.trim().length > 0
      ? extensionMcpConfig.url.trim()
      : `http://localhost:${config.gateway.port}/mcp`;
  const extensionMcpHeaders = config.gateway.token
    ? { Authorization: `Bearer ${config.gateway.token}` }
    : undefined;
  const claudeRuntime = config.agentHost?.claudeRuntime === "cli" ? "cli" : "sdk";
  const backgroundDir = defaultBackgroundDir();
  const personaFile = resolvePersonaFile(config.agentHost?.persona);
  log.info("Claude runtime selected", { runtime: claudeRuntime, persona: personaFile ?? "none" });
  const providers = {
    claude:
      claudeRuntime === "cli"
        ? createClaudeCliProvider({
            ...config.agentHost?.claudeCli,
            systemPromptFile: personaFile,
            systemPromptMode: config.agentHost?.personaMode,
            model: config.session.model,
            extensionMcp: {
              serverName: extensionMcpConfig.serverName || "anima",
              url: extensionMcpUrl,
              headers: extensionMcpHeaders,
            },
            // Permission prompts answered through Claude Code's hook. Its
            // token is derived from the gateway token, so no token, no hook.
            permissionHook: expectedToken
              ? {
                  url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}${PERMISSION_HOOK_PATH}`,
                  secret: expectedToken,
                }
              : undefined,
            // Every launch saves its background work at each turn's end.
            backgroundDir,
            hookSettingsPath: writeHookSettings({
              permission: Boolean(expectedToken),
              backgroundDir,
            }),
          })
        : createAnthropicProvider({
            systemPromptFile: personaFile,
            imageProcessing:
              configuredImageProcessing &&
              typeof configuredImageProcessing === "object" &&
              !Array.isArray(configuredImageProcessing)
                ? (configuredImageProcessing as AnimaConfig["session"]["imageProcessing"])
                : config.session.imageProcessing,
            skillsPaths:
              configuredSkills &&
              typeof configuredSkills === "object" &&
              !Array.isArray(configuredSkills) &&
              Array.isArray((configuredSkills as { paths?: unknown }).paths)
                ? (configuredSkills as { paths: string[] }).paths || []
                : config.session.skills.paths,
            extensionMcp: {
              enabled: extensionMcpEnabled,
              serverName: extensionMcpConfig.serverName || "anima",
              url: extensionMcpUrl,
              headers: extensionMcpHeaders,
              alwaysLoad: extensionMcpConfig.alwaysLoad,
            },
          }),
    codex: createCodexProvider(config.agentHost?.codex),
  };
  const sessionHost =
    options.sessionHost ??
    new SessionHost({
      providers,
      profiles: config.agentHost?.sessionProfiles,
    });
  const sessionModel =
    typeof sessionExtConfig.model === "string" && sessionExtConfig.model.trim().length > 0
      ? sessionExtConfig.model.trim()
      : undefined;
  const sessionThinking =
    typeof sessionExtConfig.thinking === "boolean" ? sessionExtConfig.thinking : undefined;
  const sessionEffort =
    sessionExtConfig.effort === "low" ||
    sessionExtConfig.effort === "medium" ||
    sessionExtConfig.effort === "high" ||
    sessionExtConfig.effort === "max"
      ? (sessionExtConfig.effort as ThinkingEffort)
      : undefined;
  sessionHost.setDefaults({
    model: sessionModel,
    thinking: sessionThinking,
    effort: sessionEffort,
  });
  log.info("Loaded config", {
    model: sessionModel,
    thinking: sessionThinking,
    effort: sessionEffort,
  });

  // Prime the liveness snapshot before anything reads it: restore, adoption and
  // state persistence all ask which sessions are alive, and an unprimed
  // snapshot answers "none".
  const liveness =
    options.liveness !== undefined
      ? options.liveness
      : process.env.NODE_ENV !== "test" && claudeRuntime === "cli"
        ? hostLiveness
        : null;
  if (liveness) {
    await liveness.refresh();
    liveness.start(options.livenessIntervalMs ?? 5_000);
  }

  // Load persisted session registry (for crash recovery)
  const persistedState = loadStateFn();
  log.info("Persisted state loaded", { sessions: persistedState.sessions.length });

  // Restore sessions to memory
  await restorePersistedSessions(sessionHost, persistedState, log);

  // Then repair anything the registry missed. A `claude` still running in one
  // of this instance's `<prefix>-claude-*` panes needs its proxy rebound on the exact port it was
  // launched against, whether or not `sessions.json` remembers it.
  const tracked = sessionHost.trackedIds?.() ?? new Set<string>();
  // Under `bun test` the default is "don't", not "the real tmux" — a suite that
  // simply forgets to pass `adoptDeps` must not be able to reach into the
  // developer's live sessions. Tests that exercise adoption inject their own.
  const adoptDeps =
    options.adoptDeps === undefined && process.env.NODE_ENV === "test"
      ? null
      : options.adoptDeps === undefined
        ? {
            listTmuxSessions,
            claudeProcessAlive: (id: string) => liveness?.claudeAlive(id) ?? false,
            paneCurrentPath,
            isTracked: (id: string) => tracked.has(id),
          }
        : options.adoptDeps;
  if (adoptDeps) await adoptLiveCliSessions(sessionHost, adoptDeps, log);

  // ── WebSocket Client Tracking ──────────────────────────────
  const clients = new Map<unknown, WSClient>();

  /**
   * Broadcast a session event to all clients subscribed to that session.
   */
  function broadcastSessionEvent(msg: SessionEventMessage): void {
    const data = JSON.stringify(msg);
    for (const [, client] of clients) {
      if (client.subscribedSessions.has(msg.sessionId)) {
        try {
          (client.ws as { send(data: string): void }).send(data);
        } catch (error) {
          log.warn("Failed to send to client", {
            extensionId: client.extensionId,
            error: String(error),
          });
        }
      }
    }
  }

  /**
   * Send a response to a specific WebSocket client.
   */
  function sendResponse(ws: unknown, res: ResponseMessage): void {
    try {
      (ws as { send(data: string): void }).send(JSON.stringify(res));
    } catch (error) {
      log.warn("Failed to send response", { error: String(error) });
    }
  }

  // ── Wire SessionHost events → WebSocket broadcast ──────────
  sessionHost.on("session.event", (msg: SessionEventMessage) => {
    broadcastSessionEvent(msg);
  });

  // ── Message Handler ────────────────────────────────────────
  function authenticateRequest(req: Request): boolean {
    if (!expectedToken) return false;
    const url = new URL(req.url);
    const headerToken = extractBearerToken(req.headers.get("Authorization"));
    if (headerToken && validateToken(headerToken, expectedToken)) return true;
    const queryToken = url.searchParams.get("token");
    return Boolean(queryToken && validateToken(queryToken, expectedToken));
  }

  async function handleMessage(ws: unknown, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      log.warn("Invalid JSON from client", { raw: raw.slice(0, 100) });
      return;
    }

    switch (msg.type) {
      case "auth": {
        const client: WSClient = {
          ws,
          extensionId: msg.extensionId,
          subscribedSessions: new Set(),
        };
        clients.set(ws, client);
        log.info("Client authenticated", { extensionId: msg.extensionId });

        // Handle reconnection — replay buffered events for resumed sessions
        if (msg.resumeSessions) {
          for (const { sessionId, lastSeq } of msg.resumeSessions) {
            client.subscribedSessions.add(sessionId);
            const missed = sessionHost.getEventsAfter(sessionId, lastSeq);
            log.info("Replaying missed events", {
              sessionId: sessionId.slice(0, 8),
              lastSeq,
              count: missed.length,
            });
            for (const buffered of missed) {
              const replayMsg: SessionEventMessage = {
                type: "session.event",
                sessionId,
                event: buffered.event as { type: string; [key: string]: unknown },
                seq: buffered.seq,
              };
              sendResponse(ws, replayMsg as unknown as ResponseMessage);
            }
          }
        }
        break;
      }

      case "session.create": {
        try {
          const result = await sessionHost.create(
            msg.params as {
              sessionId?: string;
              cwd: string;
              agent?: string;
              model?: string;
              systemPrompt?: string;
              thinking?: boolean;
              effort?: ThinkingEffort;
              profile: string;
            },
          );

          // Auto-subscribe the creating client to this session
          const client = clients.get(ws);
          if (client) {
            client.subscribedSessions.add(result.sessionId);
          }

          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
            payload: result,
          });

          // Persist state
          saveStateFn(sessionHost.getSessionRecords());
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "session.prompt": {
        try {
          // Auto-subscribe to the session being prompted
          const client = clients.get(ws);
          if (client) {
            client.subscribedSessions.add(msg.sessionId);
          }

          await sessionHost.prompt(
            msg.sessionId,
            msg.content,
            msg.cwd,
            msg.model,
            msg.agent,
            msg.profile,
          );
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
          });
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "session.interrupt": {
        const ok = sessionHost.interrupt(msg.sessionId);
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Session not found" }),
        });
        break;
      }

      case "session.answer_modal": {
        const result = await sessionHost.answerModal(msg.sessionId, msg.key, msg.fingerprint);
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok: result.ok,
          ...(result.ok ? {} : { error: result.error ?? "Failed to answer prompt" }),
        });
        break;
      }

      case "session.close": {
        try {
          await sessionHost.close(msg.sessionId);

          // Remove subscription from all clients
          for (const [, client] of clients) {
            client.subscribedSessions.delete(msg.sessionId);
          }

          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
          });

          // Persist state
          saveStateFn(sessionHost.getSessionRecords());
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "subagent.spawn": {
        try {
          const agent = msg.params.agent || "claude";
          const result = await sessionHost.create({
            sessionId: msg.params.subagentId,
            cwd: msg.params.cwd || process.cwd(),
            agent,
            model: msg.params.model,
            systemPrompt: msg.params.systemPrompt,
            thinking: msg.params.thinking,
            effort: msg.params.effort as ThinkingEffort | undefined,
            sandbox: msg.params.sandbox,
            profile: msg.params.profile,
          });
          const client = clients.get(ws);
          if (client) {
            client.subscribedSessions.add(result.sessionId);
          }
          await sessionHost.prompt(
            result.sessionId,
            msg.params.prompt,
            msg.params.cwd,
            msg.params.model,
            agent,
            msg.params.profile,
          );
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: true,
            payload: {
              subagentId: result.sessionId,
              sessionId: result.sessionId,
              parentSessionId: msg.params.parentSessionId,
              status: "running",
              message: "Subagent spawned",
            },
          });
        } catch (error) {
          sendResponse(ws, {
            type: "res",
            requestId: msg.requestId,
            ok: false,
            error: String(error),
          });
        }
        break;
      }

      case "session.set_permission_mode": {
        const ok = sessionHost.setPermissionMode(msg.sessionId, msg.mode);
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Session not found" }),
        });
        break;
      }

      case "session.send_tool_result": {
        const ok = sessionHost.sendToolResult(
          msg.sessionId,
          msg.toolUseId,
          msg.content,
          msg.isError,
        );
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok,
          ...(ok ? {} : { error: "Session not found" }),
        });
        break;
      }

      case "session.subscribe": {
        const client = clients.get(ws);
        const ids = msg.sessionIds ?? [];
        if (client) for (const id of ids) client.subscribedSessions.add(id);
        log.info("Client subscribed to sessions", {
          extensionId: client?.extensionId ?? "(unauthenticated)",
          count: ids.length,
        });
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok: true,
          payload: { subscribed: client ? ids.length : 0 },
        });
        break;
      }

      case "session.list": {
        const sessions = sessionHost.list();
        sendResponse(ws, {
          type: "res",
          requestId: msg.requestId,
          ok: true,
          payload: sessions,
        });
        break;
      }

      default: {
        log.warn("Unknown message type", { type: (msg as { type: string }).type });
        break;
      }
    }
  }

  /** Set once shutdown starts: hooks are told to ask the next agent-host. */
  let stopping = false;

  /**
   * `POST /hooks/permission-request` from a CLI session's `PermissionRequest`
   * hook. Held open until the prompt is answered or settled; the reply is
   * `{ decision }` (null leaves it to the dialog) or `{ retry: true }`.
   */
  async function handlePermissionHook(req: Request): Promise<Response> {
    if (stopping) return Response.json({ retry: true }, { status: 503 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const request = parsePermissionHookRequest(body);
    if (!request) return Response.json({ error: "Invalid request" }, { status: 400 });
    const token = extractBearerToken(req.headers.get("Authorization"));
    if (!expectedToken || !verifyPermissionHookToken(expectedToken, request.sessionId, token)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const reply = sessionHost.requestPermission
      ? await sessionHost.requestPermission(request.sessionId, request, req.signal)
      : { decision: null };
    return Response.json(reply);
  }

  // ── Bun Server ─────────────────────────────────────────────
  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        if (!authenticateRequest(req)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        // Use count() not list() — list shells out to tmux + ps per session,
        // and with many idle CLI panes /health blew past the watchdog's 2s
        // fetch timeout, causing it to SIGKILL agent-host every ~35s.
        return Response.json({
          ok: true,
          uptime: process.uptime(),
          sessions: sessionHost.count(),
          clients: clients.size,
        });
      }

      if (url.pathname === PERMISSION_HOOK_PATH && req.method === "POST") {
        // Held open until someone answers; Bun's idle timeout would cut it.
        server.timeout(req, 0);
        return handlePermissionHook(req);
      }

      if (url.pathname === "/ws") {
        if (!authenticateRequest(req)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const success = server.upgrade(req);
        if (!success) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open() {
        log.info("WebSocket client connected");
      },
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        await handleMessage(ws, raw);
      },
      close(ws) {
        const client = clients.get(ws);
        if (client) {
          log.info("WebSocket client disconnected", { extensionId: client.extensionId });
          clients.delete(ws);
        }
      },
    },
  });

  log.info(`Agent Host server listening on port ${port}`);

  // ── Periodic State Persistence ─────────────────────────────
  const stateSaveTimer =
    stateSaveIntervalMs === null
      ? null
      : setInterval(() => {
          const records = sessionHost.getSessionRecords();
          if (records.length > 0) {
            saveStateFn(records);
          }
        }, stateSaveIntervalMs);

  async function stop(signal?: string, options: StopOptions = {}): Promise<void> {
    if (signal) {
      log.info(`Received ${signal}, shutting down...`);
    }

    if (stateSaveTimer) {
      clearInterval(stateSaveTimer);
    }
    liveness?.stop();

    saveStateFn(sessionHost.getSessionRecords());
    // Releasing closes every proxy listener first, then the WS server goes,
    // so by the time agent-host's port is free the proxy ports are too and a new
    // agent-host can take them all. `true` closes the open websockets:
    // the session extension must reconnect to the new process, not linger on
    // this one while it drains.
    stopping = true;
    const drains = await sessionHost.closeAll();
    server.stop(true);
    const drainMs = options.drainMs ?? 0;
    if (drainMs > 0) await awaitDrains(drains, drainMs, log);

    if (signal) {
      log.info("Agent Host shut down cleanly");
    }
  }

  return {
    server,
    sessionHost,
    clients,
    handleMessage,
    broadcastSessionEvent,
    stop,
    port,
  };
}
