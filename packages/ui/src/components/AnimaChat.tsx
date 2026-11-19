import { useState, useCallback, useEffect, useEffectEvent } from "react";
import { Transition } from "@headlessui/react";
import { BridgeContext, useBridge } from "../bridge";
import type { PlatformBridge } from "../bridge";
import type { Attachment } from "../types";
import { useChatGateway } from "../hooks/useChatGateway";
import type { UseChatGatewayOptions } from "../hooks/useChatGateway";
import { WorkspaceProvider } from "../contexts/WorkspaceContext";
import { Header } from "./Header";
import { ContextBar } from "./ContextBar";
import { MessageList } from "./MessageList";
import { InputArea } from "./InputArea";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { StatusBar } from "./StatusBar";
import CompactionIndicator from "./CompactionIndicator";
import { SubagentActivityStrip } from "./SubagentActivityStrip";

const ENABLE_THINKING_TUNER = false;

interface AnimaChatProps {
  bridge: PlatformBridge;
  /** Gateway options (sessionId for web, autoDiscoverCwd for embedded clients) */
  gatewayOptions?: UseChatGatewayOptions;
  /** Optional back navigation callback */
  onBack?: () => void;
  /** Optional hamburger callback — when provided, Header renders a menu button (mobile nav). */
  onOpenMenu?: () => void;
  /**
   * Render the per-chat `Header` (workspace name, connection
   * dot). Defaults to `true` for embedded clients (an editor plugin, a native app).
   * The web SPA's `ChatPanel` passes `false` so the global `AppHeader`
   * chrome owns those affordances instead.
   */
  showHeader?: boolean;
}

export function AnimaChat({
  bridge,
  gatewayOptions,
  onBack,
  onOpenMenu,
  showHeader = true,
}: AnimaChatProps) {
  return (
    <BridgeContext.Provider value={bridge}>
      <ChatInner
        gatewayOptions={gatewayOptions}
        onBack={onBack}
        onOpenMenu={onOpenMenu}
        showHeader={showHeader}
      />
    </BridgeContext.Provider>
  );
}

function ChatInner({
  gatewayOptions,
  onBack,
  onOpenMenu,
  showHeader,
}: {
  gatewayOptions?: UseChatGatewayOptions;
  onBack?: () => void;
  onOpenMenu?: () => void;
  showHeader: boolean;
}) {
  const bridge = useBridge();
  const [thinkingVisible, setThinkingVisible] = useState(() => {
    try {
      return localStorage.getItem("anima:thinking:visible") !== "false";
    } catch {
      return true;
    }
  });
  const [thinkingInactivityMs, setThinkingInactivityMs] = useState(() => {
    try {
      const raw = Number(localStorage.getItem("anima:thinking:inactivityMs"));
      if (Number.isFinite(raw) && raw >= 100) return raw;
    } catch {
      /* noop */
    }
    return 300;
  });
  const [toolTickMs, setToolTickMs] = useState(() => {
    try {
      const raw = Number(localStorage.getItem("anima:thinking:toolTickMs"));
      if (Number.isFinite(raw) && raw >= 30) return raw;
    } catch {
      /* noop */
    }
    return 100;
  });

  const gateway = useChatGateway(bridge.gatewayUrl, gatewayOptions);

  const [input, setInput] = useState(() => bridge.loadDraft());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const shouldShowThinkingPanel = ENABLE_THINKING_TUNER
    ? thinkingVisible
    : gateway.isQuerying || gateway.isCompacting;

  useEffect(() => {
    gateway.setToolSimulationIntervalMs(toolTickMs);
  }, [gateway.setToolSimulationIntervalMs, toolTickMs]);

  useEffect(() => {
    try {
      localStorage.setItem("anima:thinking:visible", String(thinkingVisible));
      localStorage.setItem("anima:thinking:inactivityMs", String(thinkingInactivityMs));
      localStorage.setItem("anima:thinking:toolTickMs", String(toolTickMs));
    } catch {
      /* noop */
    }
  }, [thinkingVisible, thinkingInactivityMs, toolTickMs]);

  // Get editor context if bridge provides it
  const editorContext = bridge.useEditorContext?.();

  // Listen for external send requests (e.g. an "Explain This Code" command from an editor plugin).
  // The deferred send reads `gateway`/`bridge.saveDraft` only
  // from inside the setTimeout, so wrap it in `useEffectEvent` to keep the
  // listener subscription stable across renders.
  const onExternalSend = useEffectEvent((text: string) => {
    gateway.sendPrompt(text, []);
    setInput("");
    bridge.saveDraft("");
  });

  useEffect(() => {
    if (!bridge.onSendRequest) return;
    return bridge.onSendRequest((text) => {
      setInput(text);
      // Auto-send after a tick so the input renders first
      setTimeout(() => onExternalSend(text), 0);
    });
  }, [bridge]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    gateway.sendPrompt(input, attachments);
    setInput("");
    setAttachments([]);
    bridge.saveDraft("");
  }, [input, attachments, gateway, bridge]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
  }, []);

  /** For interactive tools (AskUserQuestion, ExitPlanMode) to send messages */
  const handleToolMessage = useCallback(
    (text: string) => {
      gateway.sendPrompt(text, []);
    },
    [gateway],
  );

  /** For interactive tools to send tool_result directly */
  const handleToolResult = useCallback(
    (toolUseId: string, content: string, isError?: boolean) => {
      gateway.sendToolResult(toolUseId, content, isError);
    },
    [gateway],
  );

  return (
    <WorkspaceProvider cwd={gateway.workspace?.cwd}>
      <div className="relative flex h-full min-h-0 w-full flex-col">
        {showHeader && (
          <Header
            isConnected={gateway.isConnected}
            sessionId={gateway.sessionId}
            workspace={gateway.workspace}
            sessions={gateway.sessions}
            onCreateSession={gateway.createNewSession}
            onSwitchSession={gateway.switchSession}
            sendRequest={gateway.sendRequest}
            onBack={onBack}
            onOpenMenu={onOpenMenu}
          />
        )}

        {bridge.showContextBar && <ContextBar context={editorContext} />}

        <MessageList
          messages={gateway.messages}
          visibleCount={gateway.visibleCount}
          isQuerying={gateway.isQuerying}
          hasMore={gateway.hasMore}
          totalMessages={gateway.totalMessages}
          earlierCount={gateway.earlierCount}
          onLoadEarlier={gateway.loadEarlierMessages}
          messagesContainerRef={gateway.messagesContainerRef}
          messagesEndRef={gateway.messagesEndRef}
          onSendMessage={handleToolMessage}
          onSendToolResult={handleToolResult}
          onAnswerModal={gateway.answerModal}
        />

        {/* Thinking + tuning controls */}
        {ENABLE_THINKING_TUNER ? (
          shouldShowThinkingPanel ? (
            gateway.isCompacting ? (
              <div className="absolute bottom-40 right-8 z-50 bg-white/50 backdrop-blur-sm rounded-2xl shadow-2xl drop-shadow-xl border border-purple-200/50">
                <div className="flex items-center justify-end p-2">
                  <button
                    type="button"
                    onClick={() => setThinkingVisible(false)}
                    className="text-xs px-2 py-1 rounded border border-purple-200 text-purple-700 hover:bg-purple-50"
                  >
                    Hide
                  </button>
                </div>
                <CompactionIndicator />
              </div>
            ) : (
              <div className="absolute bottom-40 right-8 z-50 bg-white/50 backdrop-blur-sm rounded-2xl shadow-2xl drop-shadow-xl p-4 border border-purple-100/50">
                <div className="mb-2 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => setThinkingVisible(false)}
                    className="text-xs px-2 py-1 rounded border border-purple-200 text-purple-700 hover:bg-purple-50"
                  >
                    Hide
                  </button>
                </div>
                <ThinkingIndicator
                  count={gateway.eventCount}
                  streamCount={gateway.streamEventCount}
                  simulatedCount={gateway.simulatedEventCount}
                  showCounters
                  size="lg"
                  isActive={gateway.isQuerying}
                  inactivityTimeout={thinkingInactivityMs}
                />
                <div className="mt-3 space-y-2 text-xs text-purple-900">
                  <label className="block" aria-label="Simulated tick (ms)">
                    <span className="mb-1 flex items-center justify-between">
                      <span>Simulated Tick</span>
                      <span>{toolTickMs}ms</span>
                    </span>
                    <input
                      type="range"
                      min={30}
                      max={500}
                      step={10}
                      value={toolTickMs}
                      onChange={(e) => setToolTickMs(Number(e.target.value))}
                      className="w-full accent-purple-600"
                    />
                  </label>
                  <label className="block" aria-label="Fade to black (ms)">
                    <span className="mb-1 flex items-center justify-between">
                      <span>Fade To Black</span>
                      <span>{thinkingInactivityMs}ms</span>
                    </span>
                    <input
                      type="range"
                      min={100}
                      max={2000}
                      step={50}
                      value={thinkingInactivityMs}
                      onChange={(e) => setThinkingInactivityMs(Number(e.target.value))}
                      className="w-full accent-purple-600"
                    />
                  </label>
                </div>
              </div>
            )
          ) : (
            <button
              type="button"
              onClick={() => setThinkingVisible(true)}
              className="absolute bottom-40 right-8 z-50 rounded-full border border-purple-200 bg-white/80 px-3 py-2 text-xs font-medium text-purple-800 shadow-lg backdrop-blur-sm hover:bg-purple-50"
            >
              Show Anima
            </button>
          )
        ) : (
          <Transition
            show={shouldShowThinkingPanel}
            enter="transition-all duration-350 ease-out"
            enterFrom="opacity-0 translate-y-2 scale-95"
            enterTo="opacity-100 translate-y-0 scale-100"
            leave="transition-all duration-350 ease-in"
            leaveFrom="opacity-100 translate-y-0 scale-100"
            leaveTo="opacity-0 translate-y-1 scale-95"
          >
            {gateway.isCompacting ? (
              <div className="absolute bottom-40 right-8 z-50 bg-white/50 backdrop-blur-sm rounded-2xl shadow-2xl drop-shadow-xl border border-purple-200/50">
                <CompactionIndicator />
              </div>
            ) : (
              <div className="absolute bottom-40 right-8 z-50 bg-white/50 backdrop-blur-sm rounded-2xl shadow-2xl drop-shadow-xl p-4 border border-purple-100/50">
                <ThinkingIndicator
                  count={gateway.eventCount}
                  streamCount={gateway.streamEventCount}
                  simulatedCount={gateway.simulatedEventCount}
                  showCounters={false}
                  size="lg"
                  isActive={gateway.isQuerying}
                  inactivityTimeout={thinkingInactivityMs}
                />
              </div>
            )}
          </Transition>
        )}

        <StatusBar hookState={gateway.hookState} />

        <SubagentActivityStrip
          subagents={gateway.subagents}
          // Route-scoped (web) clients can open a subagent's own session; it
          // lives in its parent's workspace.
          subagentHref={
            gatewayOptions?.workspaceId
              ? (subagentId) => `/chat/${gatewayOptions.workspaceId}/${subagentId}`
              : undefined
          }
        />

        <InputArea
          input={input}
          onInputChange={handleInputChange}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          isConnected={gateway.isConnected}
          isQuerying={gateway.isQuerying}
          usage={gateway.usage}
          model={gateway.model}
          idleSince={gateway.idleSince}
          idleCompaction={gateway.idleCompaction}
          onSend={handleSend}
          onInterrupt={gateway.sendInterrupt}
          gitStatus={gateway.gitStatus}
        />
      </div>
    </WorkspaceProvider>
  );
}
