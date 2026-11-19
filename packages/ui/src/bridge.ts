import { createContext, use } from "react";
import type { EditorContext } from "./types";

/**
 * PlatformBridge - abstracts platform-specific behavior.
 *
 * Each platform (the web app, an embedded client such as an editor plugin)
 * implements this interface differently.
 * Provided to the component tree via React Context.
 */
export interface PlatformBridge {
  /** Platform identifier */
  platform: "web" | "embedded";

  /** Gateway WebSocket URL */
  gatewayUrl: string;

  /** Whether to show the editor context bar (editor plugins) */
  showContextBar: boolean;

  /** Whether to include file context in prompts automatically */
  includeFileContext: boolean;

  // -- Draft persistence --

  /** Save draft text */
  saveDraft(text: string): void;

  /** Load saved draft text */
  loadDraft(): string;

  // -- Clipboard --

  /** Copy text to clipboard (different API in webview vs browser) */
  copyToClipboard(text: string): Promise<void>;

  // -- Editor-host specific (optional) --

  /** Open a file in the host editor */
  openFile?(path: string): void;

  /** Apply an edit to a file */
  applyEdit?(path: string, content: string): void;

  /** Open terminal */
  openTerminal?(): void;

  /** Show notification in host */
  showNotification?(type: "info" | "error", text: string): void;

  // -- External integrations --

  /** Subscribe to external send requests (e.g. "Explain This Code" command) */
  onSendRequest?(callback: (text: string) => void): () => void;

  /** Get current editor context (editor hosts only, reactive via useSyncExternalStore) */
  useEditorContext?(): EditorContext | undefined;
}

export const BridgeContext = createContext<PlatformBridge | null>(null);

export function useBridge(): PlatformBridge {
  const bridge = use(BridgeContext);
  if (!bridge) {
    throw new Error("useBridge must be used within a BridgeContext.Provider");
  }
  return bridge;
}
