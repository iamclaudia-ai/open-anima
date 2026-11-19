import { useCallback, useRef } from "react";
import type { Attachment, Usage } from "../types";
import { useBridge } from "../bridge";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCommands } from "../hooks/useCommands";
import { useFiles } from "../hooks/useFiles";
import { useFileAttachments } from "../hooks/useFileAttachments";
import { useFocusRestore } from "../hooks/useFocusRestore";
import { useInputPickers } from "../hooks/useInputPickers";
import { useTextareaAutosize } from "../hooks/useTextareaAutosize";
import { AttachmentsList } from "./AttachmentsList";
import { CommandPicker } from "./CommandPicker";
import { ContextRing } from "./ContextRing";
import { IdleCompactionCountdown } from "./CompactionIndicator";
import { FilePicker } from "./FilePicker";
import { GitStatusBar } from "./GitStatusBar";
import { SendStopButton } from "./SendStopButton";
import type { GitStatusInfo } from "../hooks/useChatGateway";

interface InputAreaProps {
  input: string;
  onInputChange(value: string): void;
  attachments: Attachment[];
  onAttachmentsChange(attachments: Attachment[]): void;
  isConnected: boolean;
  isQuerying: boolean;
  usage: Usage | null;
  /** The session's model id (sets the context ring's window). */
  model: string | null;
  /** Epoch ms the last turn ended, for the idle-compaction countdown. */
  idleSince: number | null;
  /** Whether the session's runtime compacts it when idle. */
  idleCompaction: boolean;
  onSend(): void;
  onInterrupt(): void;
  gitStatus?: GitStatusInfo | null;
}

export function InputArea({
  input,
  onInputChange,
  attachments,
  onAttachmentsChange,
  isConnected,
  isQuerying,
  usage,
  model,
  idleSince,
  idleCompaction,
  onSend,
  onInterrupt,
  gitStatus,
}: InputAreaProps) {
  const bridge = useBridge();
  const workspace = useWorkspace();
  const { items: commandItems } = useCommands(workspace.cwd);
  const { files } = useFiles(workspace.cwd);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaContainerRef = useRef<HTMLDivElement>(null);

  // ── Autosize ────────────────────────────────────────────────────────────
  useTextareaAutosize(textareaRef, input);

  // ── Pickers (slash + file `@`) ──────────────────────────────────────────
  const pickers = useInputPickers({
    input,
    onInputChange,
    saveDraft: bridge.saveDraft,
    commandItems,
    files,
    textareaRef,
  });

  // Focus restore needs the same cursor ref the pickers use.
  useFocusRestore(textareaRef, pickers.cursorPositionRef, isConnected);

  // ── Attachments (paste / drop / remove) ─────────────────────────────────
  const { isDragging, handlePaste, handleDragOver, handleDragLeave, handleDrop, removeAttachment } =
    useFileAttachments({ attachments, onAttachmentsChange });

  // ── Input event wiring ──────────────────────────────────────────────────
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      onInputChange(value);
      bridge.saveDraft(value);
      pickers.notifyInputChange(value, {
        start: e.target.selectionStart,
        end: e.target.selectionEnd,
      });
    },
    [onInputChange, bridge, pickers],
  );

  const handleBlur = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    pickers.cursorPositionRef.current = {
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  }, [pickers]);

  // ── Keyboard handler — pickers first, then the global Cmd+Enter / Escape bindings. ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (pickers.handlePickerKeyDown(e)) return;

      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        onSend();
        return;
      }
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onInterrupt();
        return;
      }
    },
    [pickers, onSend, onInterrupt],
  );

  const hasContent = input.trim().length > 0 || attachments.length > 0;

  return (
    <footer className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-gray-200">
      <AttachmentsList attachments={attachments} onRemove={removeAttachment} />

      <div
        ref={textareaContainerRef}
        className={`relative ${isDragging ? "ring-2 ring-blue-500 ring-offset-2 rounded-lg" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CommandPicker
          isOpen={pickers.cmdActive}
          query={pickers.cmdQuery}
          filtered={pickers.cmdFiltered}
          selectedIndex={pickers.cmdSelectedIndex}
          onSelectedIndexChange={pickers.setCmdSelectedIndex}
          onPick={pickers.acceptCommandSelection}
        />

        <FilePicker
          isOpen={pickers.fileActive}
          filtered={pickers.fileFiltered}
          selectedIndex={pickers.fileSelectedIndex}
          onSelectedIndexChange={pickers.setFileSelectedIndex}
          onPick={pickers.acceptFileSelection}
        />

        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSelect={pickers.handleSelect}
          onPaste={handlePaste}
          onBlur={handleBlur}
          placeholder={
            isConnected
              ? "Type a message... (⌘↵ send, ESC stop)"
              : "Disconnected - type to compose (will send when reconnected)"
          }
          className={`w-full p-3 pr-12 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-300 ${!isConnected ? "bg-orange-50 border-orange-200" : ""}`}
          rows={1}
          style={{ minHeight: "96px", maxHeight: "200px", overflow: "auto" }}
        />

        {idleCompaction && (
          <IdleCompactionCountdown usage={usage} idleSince={isQuerying ? null : idleSince} />
        )}

        <ContextRing usage={usage} model={model} idleCompaction={idleCompaction} />

        <SendStopButton
          isQuerying={isQuerying}
          hasContent={hasContent}
          isConnected={isConnected}
          onSend={onSend}
          onInterrupt={onInterrupt}
        />

        {isDragging && (
          <div className="absolute inset-0 bg-blue-50/80 rounded-lg flex items-center justify-center pointer-events-none">
            <span className="text-blue-600 font-medium">Drop files here</span>
          </div>
        )}
      </div>

      <GitStatusBar status={gitStatus ?? null} />
    </footer>
  );
}
