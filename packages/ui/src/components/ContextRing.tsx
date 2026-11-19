import type { Usage } from "../types";
import {
  contextTokens,
  contextWindowFor,
  contextZone,
  formatTokens,
  type ContextZone,
} from "./context-window";

const RING_CIRCUMFERENCE = 87.96; // 2 * pi * 14 (the ring radius)

const ZONE_COLORS: Record<ContextZone, string> = {
  empty: "#d1d5db", // gray-300
  normal: "#10b981", // emerald-500
  ready: "#f97316", // orange-500
  danger: "#dc2626", // red-600
};

const ZONE_NOTES: Record<ContextZone, string> = {
  empty: "",
  normal: "",
  ready: " · a long break compacts it",
  danger: " · time to /compact",
};

interface ContextRingProps {
  usage: Usage | null;
  /** The session's model id; `[1m]` selects the 1M window. */
  model: string | null;
  /** Whether the runtime compacts an idle session (Claude Code does). */
  idleCompaction: boolean;
}

/**
 * Small SVG ring that fills with the share of the model's context window in
 * use: green, then orange once idle compaction can fire (200K), then red past
 * 60% of the window. Renders nothing when usage is null (no model call yet).
 */
export function ContextRing({ usage, model, idleCompaction }: ContextRingProps) {
  if (!usage) return null;
  const tokens = contextTokens(usage);
  const window = contextWindowFor(model);
  const percent = (tokens / window) * 100;
  const zone = contextZone(tokens, window);
  const label = `Context: ${formatTokens(tokens)} of ${formatTokens(window)} (${Math.round(percent)}%)${zone === "ready" && !idleCompaction ? "" : ZONE_NOTES[zone]}`;

  return (
    <div className="absolute bottom-14 right-2 flex flex-col items-center" title={label}>
      <svg width="32" height="32" viewBox="0 0 32 32" role="img" aria-label={label}>
        {/* Background ring (darker gray) */}
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke="#9ca3af"
          strokeWidth="2.5"
          className="transform -rotate-90 origin-center"
          style={{ transformOrigin: "16px 16px" }}
        />
        {/* Progress ring (colored) */}
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="none"
          stroke={ZONE_COLORS[zone]}
          strokeWidth="2.5"
          strokeDasharray={`${(Math.min(percent, 100) / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          strokeLinecap="round"
          className="transform -rotate-90 origin-center"
          style={{ transformOrigin: "16px 16px" }}
        />
        {percent > 0 && (
          <text
            x="16"
            y="16"
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-[9px] font-mono font-semibold fill-gray-600"
          >
            {Math.round(percent)}
          </text>
        )}
      </svg>
    </div>
  );
}
