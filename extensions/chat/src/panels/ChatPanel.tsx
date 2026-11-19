/**
 * ChatPanel — The conversation view.
 *
 * Reads active workspace/session from `useChatPage()`. Empty state when no
 * session is selected (so the user sees a "create one" prompt instead of a
 * blank panel).
 *
 * On mobile, the layout drops the nav panel — so this panel renders a
 * hamburger affordance in AnimaChat's Header that slides NavPanel in as
 * an overlay drawer. Auto-closes when the active session changes.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AnimaChat,
  getRememberedPanelWidth,
  Link,
  navigate,
  rememberPanelWidth,
  SessionMenu,
  useAttentionSessions,
  useHeaderSlot,
  useIsMobile,
  useLayoutApi,
  type SessionHandoffTarget,
} from "@anima/ui";
import { PanelLeft, PanelLeftDashed, X } from "lucide-react";
import { useChatPage } from "../context/ChatPageContext";
import { HandoffLinks } from "./HandoffLinks";
import { NavPanel } from "./NavPanel";
import { sessionMenuState } from "./session-menu-state";
import { WorktreeSetupStrip } from "./WorktreeSetupStrip";

const NAV_PANEL_ID = "chat.nav";
const NAV_PANEL_DEFAULT_WIDTH = 280;

/**
 * The session on screen handed its work to a new one: go there. The new
 * route remounts the chat, which loads the new session's history and stream.
 * `replace` would be wrong — Back should still reach the old transcript.
 */
function followHandoff(target: SessionHandoffTarget): void {
  if (!target.workspaceId) return;
  navigate(`/chat/${target.workspaceId}/${target.sessionId}`);
}

export function ChatPanel() {
  const {
    activeWorkspace,
    activeSessionId,
    chatBridge,
    isConnected,
    onNewSession,
    onRenameSession,
    onSetSessionDisposition,
    sessionsByWorkspace,
  } = useChatPage();
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);

  // ── Layout panel toggle (nav) ──────────────────────────────
  // Desktop: each toggle adds/removes its panel from the dockview layout
  // via the LayoutManager's published api. Mobile: the layout doesn't
  // include `chat.nav` (the drawer is an overlay).
  const layoutApi = useLayoutApi();
  const [isNavInLayout, setIsNavInLayout] = useState(false);

  // Mirror dockview's reality into local state so the icons stay in sync
  // with closes-by-drag, persisted-layout restores, etc. Both toggles
  // share one subscription since dockview emits a single change event.
  useEffect(() => {
    if (!layoutApi) return;
    const sync = () => {
      setIsNavInLayout(Boolean(layoutApi.getPanel(NAV_PANEL_ID)));
    };
    sync();
    const subscription = layoutApi.onDidLayoutChange(sync);
    return () => subscription.dispose();
  }, [layoutApi]);

  const isNavOpen = isNavInLayout || (isMobile && navOpen);

  const toggleNav = useCallback(() => {
    const existing = layoutApi?.getPanel(NAV_PANEL_ID);
    if (isMobile) {
      // The phone layout has no docked nav. If one got in anyway, the toggle
      // takes it out rather than opening the drawer on top of it.
      if (existing) existing.api.close();
      else setNavOpen((prev) => !prev);
      return;
    }
    if (!layoutApi) return;
    if (existing) {
      // Snapshot width before close — clamped by registered min/max
      // constraints, so a future open won't restore a stale extreme.
      rememberPanelWidth(NAV_PANEL_ID, existing.api.width);
      existing.api.close();
      return;
    }
    const ref = layoutApi.getPanel("chat.main");
    if (!ref) return;
    const width = getRememberedPanelWidth(NAV_PANEL_ID) ?? NAV_PANEL_DEFAULT_WIDTH;
    layoutApi.addPanel({
      id: NAV_PANEL_ID,
      component: "panel-wrapper",
      params: { panelId: NAV_PANEL_ID },
      title: "Workspaces",
      position: { referencePanel: ref, direction: "left" },
      initialWidth: width,
    });
    // `initialWidth` is unreliable when adding next to existing siblings —
    // dockview falls back to a 50/50 split. Pin the size in a microtask
    // so dockview has finished placing the panel first. (Same trick the
    // LayoutManager uses for initial layout build.)
    queueMicrotask(() => layoutApi.getPanel(NAV_PANEL_ID)?.api.setSize({ width }));
  }, [isMobile, layoutApi]);

  // ── Global header slots ────────────────────────────────────
  // ChatPanel is the canonical owner of "what chat-context is active right
  // now" — workspace name, connection status, link back home. Other
  // panels contribute their own slots; the AppHeader
  // composes them into segments. See `useHeaderSlot` in @anima/ui.
  useHeaderSlot(
    "left",
    "chat.nav-toggle",
    <button
      type="button"
      onClick={toggleNav}
      className="rounded-md p-1.5 text-gray-600 transition-colors hover:bg-white/40 hover:text-gray-800"
      title={isNavOpen ? "Hide workspaces" : "Show workspaces"}
      aria-label={isNavOpen ? "Hide workspaces" : "Show workspaces"}
      aria-pressed={isNavOpen}
    >
      {isNavOpen ? <PanelLeftDashed className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
    </button>,
    { order: 10 },
  );
  useHeaderSlot(
    "left",
    "chat.home",
    <Link to="/" className="text-sm font-semibold text-purple-700 hover:text-purple-800">
      Anima
    </Link>,
    { order: 20 },
  );
  useHeaderSlot(
    "center",
    "chat.workspace",
    <span className="truncate text-sm font-medium text-gray-800">
      {activeWorkspace?.name ?? ""}
    </span>,
  );
  // ── Session ⋯ menu ─────────────────────────────────────────
  // The same actions as the nav row's menu, reachable without opening the
  // nav. On a phone the nav is a drawer that is usually closed, and on any
  // screen the row's menu only shows on hover.
  const { sessions: queue, setPinned } = useAttentionSessions();
  const listedSession = activeWorkspace
    ? sessionsByWorkspace[activeWorkspace.id]?.find((s) => s.sessionId === activeSessionId)
    : undefined;
  const queuedSession = queue.find((s) => s.sessionId === activeSessionId);
  const menuState = activeSessionId
    ? sessionMenuState(activeSessionId, listedSession, queuedSession)
    : null;
  // The handlers patch the nav's copy optimistically and restore what they
  // were given on failure, so they get the menu's (freshest) view of it.
  const menuSession =
    activeSessionId && menuState
      ? {
          ...listedSession,
          sessionId: activeSessionId,
          title: menuState.title || undefined,
          disposition: menuState.disposition,
        }
      : null;
  useHeaderSlot(
    "center",
    "chat.session-menu",
    menuSession && menuState ? (
      <SessionMenu
        variant="header"
        sessionId={menuSession.sessionId}
        heading={menuState.heading}
        disposition={menuState.disposition}
        pinned={menuState.pinned}
        onTogglePin={
          menuState.pinned === undefined
            ? undefined
            : () => void setPinned(menuSession.sessionId, !menuState.pinned)
        }
        renameField={{
          initial: menuState.title,
          placeholder: menuState.derivedName,
          onCommit: (title) => void onRenameSession(menuSession, title),
        }}
        onSetDisposition={(disposition) => void onSetSessionDisposition(menuSession, disposition)}
        onAcknowledge={
          menuState.disposition === "resolved"
            ? undefined
            : () => void onSetSessionDisposition(menuSession, "resolved")
        }
      />
    ) : null,
    { order: 110, enabled: menuSession !== null },
  );
  useHeaderSlot(
    "right",
    "chat.connection",
    <span
      className={`block h-2 w-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}
      title={isConnected ? "Connected" : "Disconnected"}
    />,
    { order: 90 },
  );

  // Auto-close the mobile drawer when the user picks a session, or when
  // we leave mobile (e.g., user rotates / resizes back to desktop). The
  // AppHeader's nav-toggle is the canonical way to open it now — we used
  // to render an inline hamburger here too, but the header toggle covers
  // both desktop and mobile, so the inline button became redundant.
  useEffect(() => {
    setNavOpen(false);
  }, [activeSessionId, activeWorkspace?.id, isMobile]);

  // Dockview's content container has its own (dark) background — paint over
  // it with white at the panel root so we don't inherit theme colors.
  let body: React.ReactNode;
  if (!activeSessionId || !activeWorkspace) {
    body = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white">
        <p className="text-gray-400">
          {activeWorkspace
            ? "No sessions yet for this workspace"
            : "Select a workspace to get started"}
        </p>
        {activeWorkspace && (
          <button
            type="button"
            onClick={() => onNewSession()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            Create new session
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex h-full w-full flex-col bg-white">
        <HandoffLinks
          workspaceId={activeWorkspace.id}
          sessionId={activeSessionId}
          sessions={sessionsByWorkspace[activeWorkspace.id] ?? []}
        />
        <WorktreeSetupStrip
          sessionId={activeSessionId}
          sessions={sessionsByWorkspace[activeWorkspace.id] ?? []}
        />
        <div className="min-h-0 flex-1">
          <AnimaChat
            bridge={chatBridge}
            gatewayOptions={{
              sessionId: activeSessionId,
              workspaceId: activeWorkspace.id,
              onHandoff: followHandoff,
            }}
            // The global AppHeader already shows workspace name, connection
            // status — let it own that
            // chrome and skip AnimaChat's per-instance Header on the web.
            showHeader={false}
            // Re-mount when workspace/session changes — keeps streaming state clean.
            key={`${activeWorkspace.id}-${activeSessionId}`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {body}
      {isMobile && navOpen && (
        <>
          {/* Backdrop — soft glass tint instead of a flat dim overlay
              gives depth while keeping the underlying chat readable. */}
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-gradient-to-b from-black/10 to-black/20 backdrop-blur-xs"
          />
          {/* Sliding drawer */}
          <div className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[320px] bg-white shadow-xl">
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="absolute top-2 right-2 z-10 rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
            <NavPanel />
          </div>
        </>
      )}
    </div>
  );
}
