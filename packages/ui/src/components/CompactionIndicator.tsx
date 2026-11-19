/**
 * CompactionIndicator — real-time indicator shown while Claude Code
 * is performing context compaction.
 *
 * Positioned inline in the message area (like a thinking indicator).
 * Shows elapsed time and a pulsing animation.
 *
 * IdleCompactionCountdown — the warning before it: a big session left idle
 * compacts at ~54 minutes, so from 50 minutes the composer counts down.
 */

import { useState, useEffect } from "react";
import { Scissors } from "lucide-react";
import type { Usage } from "../types";
import {
  IDLE_COMPACT_AFTER_MS,
  IDLE_COMPACT_MIN_TOKENS,
  IDLE_COUNTDOWN_LEAD_MS,
  contextTokens,
  formatCountdown,
  idleCompactionRemainingMs,
} from "./context-window";

export default function CompactionIndicator() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-purple-200/60 bg-purple-50/80 backdrop-blur-sm animate-pulse">
        <Scissors
          className="size-3.5 text-purple-500 animate-spin"
          style={{ animationDuration: "3s" }}
        />
        <span className="text-xs font-medium text-purple-600">Compacting context...</span>
        {elapsed > 0 && (
          <span className="text-[10px] text-purple-400 tabular-nums">{elapsed}s</span>
        )}
      </div>
    </div>
  );
}

interface IdleCompactionCountdownProps {
  usage: Usage | null;
  /** Epoch ms the session's last turn ended; null while a turn runs. */
  idleSince: number | null;
}

/**
 * "Compacts in 3:42", floating over the composer's top-right corner during the
 * last four minutes before Claude Code's idle compaction fires. Sleeps until
 * then and ticks only inside that window; renders nothing otherwise.
 */
export function IdleCompactionCountdown({ usage, idleSince }: IdleCompactionCountdownProps) {
  const tokens = usage ? contextTokens(usage) : 0;
  const armed = idleSince !== null && tokens >= IDLE_COMPACT_MIN_TOKENS;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!armed || idleSince === null) return;
    const firesAt = idleSince + IDLE_COMPACT_AFTER_MS;
    const showsAt = firesAt - IDLE_COUNTDOWN_LEAD_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Sleep until the countdown opens, then tick each second until it fires.
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= firesAt) return;
      timer = setTimeout(tick, t < showsAt ? showsAt - t : 1000);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [armed, idleSince]);

  const remaining = armed ? idleCompactionRemainingMs(tokens, idleSince, now) : null;
  if (remaining === null) return null;

  return (
    <div
      className="absolute bottom-full right-0 z-20 mb-2 flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50/95 px-2.5 py-1 shadow-sm backdrop-blur-sm"
      role="status"
      title="Claude Code compacts a session idle ~54 minutes while its prompt cache is warm. Send anything to keep it as is."
    >
      <Scissors className="size-3 text-orange-500" />
      <span className="text-xs font-medium text-orange-700">
        Compacts in <span className="tabular-nums">{formatCountdown(remaining)}</span>
      </span>
    </div>
  );
}
