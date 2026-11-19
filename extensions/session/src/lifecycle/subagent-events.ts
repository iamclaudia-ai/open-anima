import { animaLogFile, createLogger, shortId } from "@anima/shared";
import type { SessionSubagent } from "./subagent-workflow";
import { SUBAGENT_STATUS_KEY, toSessionSubagentFromStored } from "./subagent-workflow";
import { updateSessionMetadata } from "../session-store";
import type { RequestContext } from "../session-types";
import { getRuntime } from "../runtime";

const log = createLogger("SessionExt:SubagentEvents", animaLogFile("session.log"));

type SessionEvent = { sessionId: string; eventName: string; [key: string]: unknown };

/** Send a notification prompt to an existing session. */
export async function sendSessionNotification(
  sessionId: string,
  text: string,
  options?: { connectionId?: string | null; tags?: string[] | null },
): Promise<void> {
  const rt = getRuntime();
  const notifCtx: RequestContext = {
    connectionId: options?.connectionId ?? null,
    tags: options?.tags ?? null,
    responseText: "",
  };
  rt.sessionActors.bindNotificationRequest(sessionId, notifCtx);

  const wrapped = `<user_notification>\n${text}\n</user_notification>`;
  const stored = rt.registry.getStoredSession(sessionId);
  // The session's folder, so agent-host can resume one whose process isn't
  // running; without it a notification only ever reached a live session.
  const cwd =
    stored?.cwd ?? (stored ? rt.registry.getWorkspace(stored.workspaceId)?.cwd : undefined);
  await rt.bridge.prompt(
    sessionId,
    wrapped,
    cwd,
    stored?.model || rt.sessionConfig.model,
    stored?.agent || "claude",
  );
}

/** Notify the parent session that a subagent has completed. */
export async function notifySubagentCompletion(subagent: SessionSubagent): Promise<void> {
  const rt = getRuntime();
  if (subagent.status === "running") return;
  if (rt.subagentNotificationsSent.has(subagent.subagentId)) return;
  rt.subagentNotificationsSent.add(subagent.subagentId);

  const elapsedSecs = Math.max(
    0,
    Math.round((Date.parse(subagent.updatedAt) - Date.parse(subagent.startedAt)) / 1000),
  );
  const agentLabel =
    subagent.agent.length > 0
      ? `${subagent.agent[0].toUpperCase()}${subagent.agent.slice(1)}`
      : "Agent";

  let content: string;
  if (subagent.status === "completed") {
    content = `${agentLabel} subagent ${subagent.subagentId} completed (${elapsedSecs}s).`;
  } else if (subagent.status === "interrupted") {
    content = `${agentLabel} subagent ${subagent.subagentId} was interrupted (${elapsedSecs}s).`;
  } else {
    content = `${agentLabel} subagent ${subagent.subagentId} failed (${elapsedSecs}s): ${
      subagent.error || "unknown error"
    }.`;
  }

  try {
    await sendSessionNotification(subagent.parentSessionId, content, subagent.context);
    log.info("Sent subagent completion notification", {
      subagentId: subagent.subagentId,
      parentSessionId: shortId(subagent.parentSessionId),
      status: subagent.status,
    });
  } catch (error) {
    log.warn("Failed subagent completion notification", {
      subagentId: subagent.subagentId,
      parentSessionId: shortId(subagent.parentSessionId),
      status: subagent.status,
      error: String(error),
    });
  }
}

/** Wire child-session completion tracking. Returns unsubscribe function. */
export function wireSubagentEvents(): () => void {
  const rt = getRuntime();

  const listener = (event: SessionEvent) => {
    const subagentId = event.sessionId;
    let subagent: SessionSubagent | null | undefined = rt.subagents.get(subagentId);
    if (!subagent) {
      subagent = toSessionSubagentFromStored(rt.registry.getStoredSession(subagentId));
      if (subagent) rt.subagents.set(subagentId, subagent);
    }
    if (!subagent) return;

    const eventType = String(event.type || "");
    // Only a running subagent can finish. A restart re-adopts finished panes and
    // can replay a synthetic `turn_stop` (abort) or report a dead process for
    // them; neither may rewrite how the real turn ended.
    if (subagent.status !== "running") return;
    if (eventType === "turn_stop") {
      subagent.status = event.stop_reason === "abort" ? "interrupted" : "completed";
    } else if (eventType === "process_died") {
      subagent.status = "failed";
      subagent.error = String(event.reason || "Subagent runtime failed");
    } else {
      return;
    }

    subagent.updatedAt = new Date().toISOString();
    // Metadata only: `runtimeStatus` belongs to the session lifecycle, which
    // writes its own value for these same events.
    updateSessionMetadata(subagentId, {
      [SUBAGENT_STATUS_KEY]: subagent.status,
      error: subagent.error,
    });

    void notifySubagentCompletion(subagent);
  };

  rt.bridge.onSessionEvent(listener);
  return () => rt.bridge.offSessionEvent(listener);
}
