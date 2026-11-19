/**
 * What the chat header's ⋯ menu knows about the session on screen.
 *
 * Two sources describe it, and either can be missing. The workspace's session
 * list (`SessionInfo`) carries the title and status for any session it has
 * loaded, but it is paginated, so an old session opened by URL may not be in
 * it. The ACTIVE queue (`AttentionSession`) is the only place `pinned` is
 * known, and it holds only unresolved sessions. The queue is fresher (it
 * polls and follows status events), so it wins where both have a value.
 */

import type { AttentionSession, SessionDisposition, SessionInfo } from "@anima/ui";

export interface SessionMenuState {
  disposition: SessionDisposition;
  /** The name shown at the top of the menu: the title, else the derived name. */
  heading: string;
  /** The explicit title, "" when there is none (the rename field's start). */
  title: string;
  /** What the session is called without a title: the rename field's placeholder. */
  derivedName: string;
  /**
   * Set only for a session in the ACTIVE queue. Pinning orders that pane, so
   * outside it (a resolved session) there is nothing to pin and no pin item.
   */
  pinned: boolean | undefined;
}

export function sessionMenuState(
  sessionId: string,
  session: SessionInfo | undefined,
  queued: AttentionSession | undefined,
): SessionMenuState {
  const title = (queued ? queued.title : session?.title)?.trim() ?? "";
  const firstPrompt = queued?.firstPrompt ?? session?.firstPrompt;
  const derivedName = firstPrompt || session?.gitBranch || sessionId.slice(0, 8);
  return {
    disposition: queued?.disposition ?? session?.disposition ?? "open",
    heading: title || derivedName,
    title,
    derivedName,
    pinned: queued ? queued.pinned : undefined,
  };
}
