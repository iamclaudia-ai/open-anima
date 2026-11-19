/**
 * Today page building blocks: the morning-stationery theme, urgency chips,
 * one-line items, and the data hook shared by the overview and drill-downs.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAttentionSessions, useGatewayClient } from "@anima/ui";
import {
  AlarmClock,
  AlarmClockOff,
  Layers,
  LoaderCircle,
  Megaphone,
  MessageCircle,
  Play,
  RotateCw,
  Ship,
} from "lucide-react";
import { sessionBusy } from "../follow-up";
import { canNudge, nudgeMessage } from "../nudge";
import { SNOOZE_CHOICES, snoozeDate, snoozedUntil, snoozeTicket } from "../snooze";
import { prStacks, reviewStackOf, type StackPr } from "../stacks";
import { cachedBoard, rememberBoard } from "./board-cache";
import { type RefLinker, refLinker, type SessionSnapshot, sessionState } from "./links";
import {
  ageDays,
  ageText,
  asking,
  type Flag,
  flagFor,
  type Item,
  type ListResponse,
  needsAttention,
  shortTitle,
  type Tone,
  type PhaseLine,
} from "./model";

// ── Theme ────────────────────────────────────────────────────

const FONTS =
  "https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Karla:wght@400;500;600&display=swap";

// A whisper of paper grain, so the page reads as stationery, not a spreadsheet.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.05'/%3E%3C/svg%3E\")";

const CSS = `
.today-root {
  --paper: #fffaf3; --card: #fffdf9; --ink: #2d2622; --muted: #8b7f77; --line: #efe4d8;
  --accent: #3b82f6; --blush: #f9c9c1;
  min-height: 100vh; color: var(--ink); font-family: Karla, ui-sans-serif, sans-serif;
  background:
    ${GRAIN},
    radial-gradient(1100px 520px at 0% -10%, #ffe4d2 0%, transparent 62%),
    radial-gradient(900px 520px at 100% -5%, #dceafe 0%, transparent 58%),
    var(--paper);
}
.today-display { font-family: Fraunces, Georgia, serif; font-optical-sizing: auto; }
.today-hand { font-family: Caveat, cursive; }
.today-card { background: var(--card); border: 1px solid var(--line); box-shadow: 0 1px 0 #fff inset, 0 6px 20px -12px rgba(120, 80, 50, .25); }
@keyframes today-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.today-rise { animation: today-rise .55s cubic-bezier(.2,.7,.2,1) both; }
.today-tile { transition: transform .18s ease, box-shadow .18s ease; }
.today-tile:hover { transform: translateY(-3px) rotate(-.4deg); box-shadow: 0 14px 28px -16px rgba(120, 80, 50, .45); }
/* The lift says "clickable"; the app-wide a:hover underline would just scribble on the tile. */
.today-tile, .today-tile:hover { text-decoration: none; }
/* The app's prose list styles (indent, bullets, row margins) would push every card and row inward. */
@layer base {
  .today-root ul, .today-root ol { padding-left: 0; list-style: none; }
  .today-root li { margin: 0; }
}
.today-check { transition: background .15s ease, border-color .15s ease, transform .15s ease; }
.today-check:hover { transform: scale(1.1); }
@media (prefers-reduced-motion: reduce) { .today-rise { animation: none; } .today-tile, .today-check { transition: none; } }
`;

export function TodayTheme({ children }: { children: ReactNode }) {
  return (
    <div className="today-root">
      <link rel="stylesheet" href={FONTS} />
      <style>{CSS}</style>
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10">{children}</div>
    </div>
  );
}

export function rise(index: number): { className: string; style: { animationDelay: string } } {
  return { className: "today-rise", style: { animationDelay: `${Math.min(index, 12) * 55}ms` } };
}

// ── Chips ────────────────────────────────────────────────────

const TONES: Record<Tone, { bg: string; fg: string }> = {
  red: { bg: "#fde3e1", fg: "#b42318" },
  amber: { bg: "#fdf0cc", fg: "#9a5b06" },
  green: { bg: "#ddf7e6", fg: "#0b7a3d" },
  blue: { bg: "#e2ebff", fg: "#2c54c4" },
  purple: { bg: "#efe4fd", fg: "#6d28d9" },
  gray: { bg: "#f1ece6", fg: "#7a6e66" },
};

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const { bg, fg } = TONES[tone];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  );
}

export function FlagChip({ flag }: { flag: Flag | null }) {
  return flag ? <Chip tone={flag.tone}>{flag.text}</Chip> : null;
}

/** A PR in a stack, shown alone: its Start button works the whole stack. */
export function StackChip({ size }: { size: number }) {
  return (
    <span className="shrink-0" title={`One of a stack of ${size} PRs: one session works them all`}>
      <Chip tone="gray">
        <Layers size={11} strokeWidth={2.5} className="mr-1" />
        stack of {size}
      </Chip>
    </span>
  );
}

// ── Start / open session ─────────────────────────────────────

export interface LaunchProps {
  launching: boolean;
  onLaunch(item: Item): void;
  /** Live sessions by id, from the attention queue; one missing from it is marked done. */
  sessions: ReadonlyMap<string, SessionSnapshot>;
  /** PRs in the item's stack (2+), whose one session Start begins; absent when it stands alone. */
  stackSize?: number;
  /** Record a nudge for one of your PRs waiting on review (`today.nudge`); posting is yours. */
  onNudge(item: Item): void;
  /** Send its session back to it (`today.follow_up`): opens the dialog first. */
  onContinue(item: Item): void;
}

/**
 * Its session has stopped and there's something to pick back up: an open item whose session isn't
 * busy and hasn't asked you anything, and, for one of your PRs, a state a session can act on (one
 * waiting on reviewers has nothing to continue).
 */
export function canContinue(item: Item, session: SessionSnapshot | undefined): boolean {
  return (
    item.status === "open" &&
    Boolean(item.sessionId && item.sessionWorkspaceId) &&
    !asking(item) &&
    !sessionBusy(session) &&
    (item.section !== "my_pr" || item.meta?.actionable === true)
  );
}

/** Continue: send the item's session back to look at what changed. */
function ContinueButton({
  item,
  launching,
  onContinue,
}: {
  item: Item;
  launching: boolean;
  onContinue(item: Item): void;
}) {
  const label = item.stateLabel
    ? `Continue the session: look at what's new (${item.stateLabel})`
    : "Continue the session: look at what's new";
  return (
    <button
      type="button"
      onClick={() => onContinue(item)}
      disabled={launching}
      aria-label={label}
      title={label}
      className="today-check grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[#cddcfb] bg-white/70 text-[var(--accent)] hover:bg-[#e2ebff] disabled:opacity-70"
    >
      {launching ? (
        <LoaderCircle size={14} className="animate-spin" />
      ) : (
        <RotateCw size={13} strokeWidth={2.5} />
      )}
    </button>
  );
}

/** Nudged reviewers already: "nudged today", "nudged 2d ago". */
function NudgedChip({ at }: { at: string }) {
  const age = ageText(ageDays(at));
  return <Chip tone="gray">nudged {age === "today" ? "today" : `${age} ago`}</Chip>;
}

/**
 * Nudge reviewers about a PR waiting on review. The board never posts: the second click (within
 * a few seconds of the first) copies a drafted message to your clipboard for you to paste where
 * your team asks for reviews, and records the nudge so the board counts the days since.
 */
function NudgeButton({ item, onNudge }: { item: Item; onNudge(item: Item): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  if (!canNudge(item)) return null;
  if (armed) {
    return (
      <button
        type="button"
        onClick={() => {
          setArmed(false);
          void navigator.clipboard?.writeText(nudgeMessage(item)).catch(() => undefined);
          onNudge(item);
        }}
        title={`Copies: ${nudgeMessage(item)}`}
        className="today-check inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#fdf0cc] px-2.5 text-[12px] font-semibold text-[#9a5b06] hover:brightness-95"
      >
        <Megaphone size={13} strokeWidth={2.25} />
        <span className="sm:hidden">Copy?</span>
        <span className="hidden sm:inline">Copy a nudge?</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      aria-label="Draft a nudge for reviewers"
      title={
        item.nudgedAt
          ? "Nudged already: copy another nudge to post"
          : "Draft a nudge for reviewers (copied for you to post)"
      }
      className="today-check grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[#f3dfae] bg-white/70 text-[#b7791f] hover:bg-[#fdf0cc]"
    >
      <Megaphone size={13} strokeWidth={2.25} />
    </button>
  );
}

/**
 * The pill that links to an item's session and says what it's doing ("Working", "Needs you").
 * It opens in a tab of its own, named for the session: the board stays put, and a second click
 * brings that tab back instead of opening another.
 */
function SessionPill({
  item,
  sessions,
  asked = asking(item),
}: {
  item: Item;
  sessions: LaunchProps["sessions"];
  /** The session asked you something (for a stack: about any of its PRs). */
  asked?: boolean;
}) {
  const href = `/chat/${item.sessionWorkspaceId}/${item.sessionId}`;
  const state = sessionState(sessions.get(item.sessionId ?? ""), asked);
  const { bg, fg } = TONES[state.tone];
  return (
    <a
      href={href}
      target={`anima-session-${item.sessionId}`}
      rel="noopener"
      title={`Open the session: ${state.label}`}
      className="today-check inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold hover:no-underline hover:brightness-95"
      style={{ background: bg, color: fg }}
    >
      {state.busy ? (
        <LoaderCircle size={13} strokeWidth={2.25} className="animate-spin" />
      ) : (
        <MessageCircle size={13} strokeWidth={2.25} />
      )}
      {state.label}
    </a>
  );
}

/** Start a session on the item, or open the one already started. */
export function LaunchButton({
  item,
  launching,
  onLaunch,
  onContinue,
  sessions,
  stackSize,
}: { item: Item } & LaunchProps) {
  const base =
    "today-check grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[#cddcfb]";
  if (item.sessionId && item.sessionWorkspaceId) {
    return (
      <>
        {canContinue(item, sessions.get(item.sessionId)) && (
          <ContinueButton item={item} launching={launching} onContinue={onContinue} />
        )}
        <SessionPill item={item} sessions={sessions} />
      </>
    );
  }
  if (item.status !== "open") return null;
  const label = stackSize
    ? `Start one session for its whole stack (${stackSize} PRs)`
    : "Start a session on this";
  return (
    <button
      type="button"
      onClick={() => onLaunch(item)}
      disabled={launching}
      aria-label={label}
      title={label}
      className={`${base} bg-white/70 text-[var(--accent)] hover:bg-[#e2ebff] disabled:opacity-70`}
    >
      {launching ? (
        <LoaderCircle size={14} className="animate-spin" />
      ) : (
        <Play size={12} strokeWidth={2.5} className="translate-x-px fill-current" />
      )}
    </button>
  );
}

// ── One-line item (overview) ─────────────────────────────────

export function ItemLine({
  item,
  launch,
  reason,
  question,
  wrap = false,
  dim = false,
  flags,
  onSnooze,
}: {
  item: Item;
  /** The snooze menu, for a ticket or a promise with one (see `SnoozeButton`). */
  onSnooze?(item: Item, until: string | null): void;
  /** Its Start button or session pill; none inside a stack card, whose header has it. */
  launch?: LaunchProps;
  /** Why it's a pick, with its PR and ticket refs already linked (see `TodayData.linked`). */
  reason?: ReactNode;
  /** Its session's question for you, linked (see `QuestionLine`). */
  question?: ReactNode;
  /** Let the title wrap instead of truncating (the top picks deserve to be read in full). */
  wrap?: boolean;
  /** Waiting on someone else: listed, but quieter */
  dim?: boolean;
  /** What to say about it instead of its own flag: a stack's PRs, or what it waits on. */
  flags?: Flag[];
}) {
  const { id, text } = shortTitle(item);
  const done = item.status !== "open";
  return (
    <li
      className={`flex items-start gap-2.5 py-1.5 ${dim ? "opacity-60 transition-opacity hover:opacity-100" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className={`flex min-w-0 gap-2 ${wrap ? "flex-wrap items-baseline" : "items-center"}`}>
          <a
            href={item.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            title={item.title}
            className={`min-w-0 text-[15px] ${wrap ? "leading-snug" : "truncate"} ${done ? "text-[var(--muted)] line-through" : "hover:underline"}`}
          >
            {id && <span className="mr-1.5 font-semibold text-[var(--muted)]">{id}</span>}
            {text}
          </a>
          {flags ? (
            flags.map((flag) => <FlagChip key={flag.text} flag={flag} />)
          ) : (
            <FlagChip flag={done ? null : flagFor(item)} />
          )}
          {launch?.stackSize && !done && <StackChip size={launch.stackSize} />}
          {item.nudgedAt && canNudge(item) && <NudgedChip at={item.nudgedAt} />}
        </div>
        {reason && (
          <p className="today-hand mt-0.5 text-lg leading-tight text-[#b4553f]">{reason}</p>
        )}
        {question}
      </div>
      {onSnooze && <SnoozeButton item={item} onSnooze={onSnooze} />}
      {launch && <NudgeButton item={item} onNudge={launch.onNudge} />}
      {launch && <LaunchButton item={item} {...launch} />}
    </li>
  );
}

// ── Snooze ────────────────────────────────────────────

/**
 * The alarm-clock menu on a ticket or a promise with a ticket: snooze it until tomorrow, for a
 * week or a month, or until you unsnooze it. The snooze is set in Linear (see snooze.ts).
 */
export function SnoozeButton({
  item,
  onSnooze,
}: {
  item: Item;
  onSnooze(item: Item, until: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  // Closes on a press outside the menu (its own button included in the menu) or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (item.status !== "open" || !snoozeTicket(item)) return null;
  const snoozed = snoozedUntil(item);
  const pick = (until: string | null) => {
    setOpen(false);
    onSnooze(item, until);
  };
  return (
    <span ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={snoozed ? "Snoozed: change or unsnooze" : "Snooze"}
        aria-label={snoozed ? "Snoozed: change or unsnooze" : "Snooze"}
        aria-expanded={open}
        className="grid h-7 w-7 place-items-center rounded-full text-[#b8a99a] hover:bg-white hover:text-[var(--muted)]"
        style={snoozed ? { color: "#7e22ce" } : undefined}
      >
        {snoozed ? <AlarmClockOff size={15} /> : <AlarmClock size={15} />}
      </button>
      {open && (
        <span
          role="menu"
          className="absolute right-0 top-8 z-20 flex w-44 flex-col rounded-xl border border-[var(--line)] bg-white py-1 text-left text-sm shadow-lg"
        >
          {SNOOZE_CHOICES.map(({ choice, label }) => (
            <button
              key={choice}
              type="button"
              role="menuitem"
              onClick={() => pick(snoozeDate(choice))}
              className="px-3 py-1.5 text-left hover:bg-[#f3eafd]"
            >
              {label}
            </button>
          ))}
          {snoozed && (
            <button
              type="button"
              role="menuitem"
              onClick={() => pick(null)}
              className="border-t border-[var(--line)] px-3 py-1.5 text-left font-semibold text-[#7e22ce] hover:bg-[#f3eafd]"
            >
              Unsnooze
            </button>
          )}
        </span>
      )}
    </span>
  );
}

// ── Full row (drill-down) ────────────────────────────────────

export function ItemRow({
  item,
  showProject,
  onPin,
  onDismiss,
  launch,
  reason,
  question,
  dim = false,
  onSnooze,
}: {
  item: Item;
  showProject: boolean;
  onSnooze?(item: Item, until: string | null): void;
  onPin(item: Item): void;
  onDismiss(item: Item): void;
  launch: LaunchProps;
  /** Why it's a pick, linked (see `TodayData.linked`). */
  reason?: ReactNode;
  /** Its session's question for you, linked (see `QuestionLine`). */
  question?: ReactNode;
  /** Waiting on someone else: listed, but quieter */
  dim?: boolean;
}) {
  const { id, text } = shortTitle(item);
  const done = item.status !== "open";
  const flag = done ? null : flagFor(item);
  const age = ageText(ageDays(item.since));
  return (
    <li
      className={`today-card flex items-start gap-3 rounded-2xl px-4 py-3 ${dim ? "opacity-60 transition-opacity hover:opacity-100" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <a
          href={item.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className={`text-[15px] leading-snug ${done ? "text-[var(--muted)] line-through" : "hover:underline"}`}
        >
          {id && <span className="mr-1.5 font-semibold text-[var(--muted)]">{id}</span>}
          {text}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
          <FlagChip flag={flag} />
          {/* A PR's flag already says its state; tickets keep theirs (Todo, In Progress…). */}
          {item.stateLabel &&
            !(item.section === "my_pr" && flag) &&
            flag?.text !== item.stateLabel && <Chip tone="gray">{item.stateLabel}</Chip>}
          {showProject && <span>{item.project}</span>}
          {item.waitingOn && <span>· {item.waitingOn}</span>}
          {launch.stackSize && <span>· stack of {launch.stackSize}</span>}
          {item.nudgedAt && canNudge(item) && <NudgedChip at={item.nudgedAt} />}
          {age && <span>· {age}</span>}
          {done && item.doneBy && item.doneBy !== "user" && <span>· closed by {item.doneBy}</span>}
        </div>
        {reason && !done && (
          <p className="today-hand mt-1 text-lg leading-tight text-[#b4553f]">{reason}</p>
        )}
        {question}
      </div>
      {onSnooze && <SnoozeButton item={item} onSnooze={onSnooze} />}
      <NudgeButton item={item} onNudge={launch.onNudge} />
      <LaunchButton item={item} {...launch} />
      {!done && (
        <div className="-ml-1 flex shrink-0 gap-0.5">
          <button
            type="button"
            onClick={() => onPin(item)}
            title={item.pinned ? "Unpin" : "Pin to today"}
            className="rounded-full px-1.5 text-base"
            style={{ color: item.pinned ? "#e0a100" : "#d6c9bc" }}
          >
            ★
          </button>
          <button
            type="button"
            onClick={() => onDismiss(item)}
            title="Not mine: dismiss"
            className="rounded-full px-1.5 text-sm text-[#d6c9bc] hover:text-[var(--muted)]"
          >
            ✕
          </button>
        </div>
      )}
    </li>
  );
}

// ── A PR stack (drill-down) ──────────────────────────────────

/** The member whose session every PR in the stack shares, when it's worked as one. */
export function stackSession(members: Item[]): Item | null {
  const lead = members.find((m) => m.sessionId && m.sessionWorkspaceId && m.sessionStack);
  return lead && members.every((m) => m.sessionId === lead.sessionId) ? lead : null;
}

/** A PR of a review stack that isn't in your queue: there for context, nothing to do. */
function ContextLine({ pr }: { pr: StackPr }) {
  const { text } = shortTitle({ title: `#${pr.number} ${pr.title}` });
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-[var(--muted)]">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-[11px]">·</span>
      <div className="min-w-0 flex-1 text-[15px] leading-snug">
        <a
          href={pr.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--muted)] hover:underline"
        >
          <span className="mr-1.5 font-semibold">#{pr.number}</span>
          {text}
        </a>
        <span className="ml-2 text-xs">not in your queue</span>
      </div>
    </li>
  );
}

/**
 * A stack of PRs (your own, or one you review), bottom first, under one header: one session works the whole stack,
 * so the header holds its Start button or session pill and the PRs list beneath it.
 */
export function StackCard({
  members,
  today,
  showProject,
  dim = false,
}: {
  members: Item[];
  today: TodayData;
  showProject: boolean;
  /** Nothing in it needs you: listed, but quieter */
  dim?: boolean;
}) {
  const bottom = members[0]!;
  const shared = stackSession(members);
  const launching = today.launching.has(bottom.id);
  // The PR in it that most needs the shared session back (Continue sends it the whole stack).
  const continuable =
    shared && !members.some(asking)
      ? members.find((m) => canContinue(m, today.sessions.get(shared.sessionId ?? "")))
      : undefined;
  // Sessions some PRs had before the stack got one of its own.
  const own = (m: Item) => !shared && m.sessionId && m.sessionWorkspaceId;
  // A review stack also holds PRs that aren't in your queue: shown as context, in place.
  const review = reviewStackOf(bottom);
  const byNumber = new Map(members.map((m) => [m.meta?.number, m]));
  const lines: Array<Item | StackPr> = review
    ? [
        ...review.map((pr) => byNumber.get(pr.number) ?? pr),
        ...members.filter((m) => !review.some((pr) => pr.number === m.meta?.number)),
      ]
    : members;
  const size = review?.length ?? members.length;
  return (
    <li
      className={`today-card rounded-2xl px-4 py-3 ${dim ? "opacity-60 transition-opacity hover:opacity-100" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Layers size={16} className={`shrink-0 ${review ? "text-[#1d4ed8]" : "text-[#15803d]"}`} />
        <span className="today-display whitespace-nowrap text-[15px] font-semibold">
          Stack of {size}
        </span>
        <span className="hidden min-w-0 truncate text-xs text-[var(--muted)] sm:inline">
          {showProject ? `${bottom.project} · ` : ""}
          {review
            ? `${bottom.waitingOn ? `${bottom.waitingOn}'s · ` : ""}${members.length} in your queue`
            : "bottom first"}
        </span>
        <span className="flex-1" />
        {shared ? (
          <>
            {continuable && (
              <ContinueButton item={continuable} launching={launching} onContinue={today.follow} />
            )}
            <SessionPill item={shared} sessions={today.sessions} asked={members.some(asking)} />
          </>
        ) : (
          <button
            type="button"
            onClick={() => today.launch(bottom)}
            disabled={launching}
            title={
              review
                ? "One session checks out the whole stack and reviews your PRs in it, bottom first"
                : "One session works every PR in this stack, in the bottom PR's worktree"
            }
            className="today-check inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[#cddcfb] bg-white/70 px-2.5 text-[12px] font-semibold text-[var(--accent)] hover:bg-[#e2ebff] disabled:opacity-70"
          >
            {launching ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <Play size={11} strokeWidth={2.5} className="fill-current" />
            )}
            {members.some((m) => m.sessionId)
              ? "One session for all"
              : review
                ? "Review the stack"
                : "Work the stack"}
          </button>
        )}
      </div>
      <ul className={`mt-1 border-l-2 pl-3 ${review ? "border-[#dbe7fb]" : "border-[#d9ecdf]"}`}>
        {lines.map((line) =>
          "id" in line ? (
            <ItemLine
              key={line.id}
              item={line}
              launch={own(line) ? launchFor(today, line) : undefined}
              reason={line.topReason && today.linked(line.topReason)}
              question={today.question(line)}
              dim={!needsAttention(line)}
              wrap
            />
          ) : (
            <ContextLine key={`pr-${line.number}`} pr={line} />
          ),
        )}
      </ul>
    </li>
  );
}

/**
 * One app's merged PRs that its production doesn't have yet, oldest first: one promote
 * ships them all, so the header holds the promote link and the one Start button for the app.
 */
export function PromoteCard({
  members,
  today,
  showProject,
}: {
  members: Item[];
  today: TodayData;
  showProject: boolean;
}) {
  const first = members[0]!;
  const { app, repo, prodTag, promoteUrl } = (first.meta ?? {}) as Record<string, string>;
  const shared = stackSession(members);
  const launching = today.launching.has(first.id);
  const continuable =
    shared && !members.some(asking)
      ? members.find((m) => canContinue(m, today.sessions.get(shared.sessionId ?? "")))
      : undefined;
  const now = new Date();
  return (
    <li className="today-card rounded-2xl px-4 py-3">
      {/* The app and its two actions stay on one row at any width; the repo line goes under it
          on a phone. */}
      <div className="flex items-center gap-2">
        <Ship size={16} className="shrink-0 text-[#0f766e]" />
        <span className="today-display min-w-0 truncate text-[15px] font-semibold">{app}</span>
        <span className="hidden min-w-0 truncate text-xs text-[var(--muted)] sm:inline">
          {showProject ? `${first.project} · ` : ""}
          {repo} · prod is {prodTag}
        </span>
        <span className="flex-1" />
        {promoteUrl && (
          <a
            href={promoteUrl}
            target="_blank"
            rel="noreferrer"
            title="Run the deploy workflow: it posts the promote for approval"
            className="text-xs font-semibold text-[#0f766e] hover:underline"
          >
            promote ↗
          </a>
        )}
        {shared ? (
          <>
            {continuable && (
              <ContinueButton item={continuable} launching={launching} onContinue={today.follow} />
            )}
            <SessionPill item={shared} sessions={today.sessions} asked={members.some(asking)} />
          </>
        ) : (
          <button
            type="button"
            onClick={() => today.launch(first)}
            disabled={launching}
            title="One session finds the promote, tells you what ships with it, and asks before running it"
            className="today-check inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[#bfe6e0] bg-white/70 px-2.5 text-[12px] font-semibold text-[#0f766e] hover:bg-[#dff4f1] disabled:opacity-70"
          >
            {launching ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <Play size={11} strokeWidth={2.5} className="fill-current" />
            )}
            Ship it
          </button>
        )}
      </div>
      <p className="mt-0.5 truncate pl-6 text-xs text-[var(--muted)] sm:hidden">
        {showProject ? `${first.project} · ` : ""}
        {repo} · prod is {prodTag}
      </p>
      <ul className="mt-1 border-l-2 border-[#cdebe6] pl-3">
        {members.map((member) => {
          const flag = flagFor(member, now);
          const age = ageText(ageDays(member.since, now));
          return (
            <ItemLine
              key={member.id}
              item={member}
              question={today.question(member)}
              // The header names the app: each line just says how long it has waited.
              flags={flag && age ? [{ ...flag, text: `merged ${age} ago` }] : undefined}
              wrap
            />
          );
        })}
      </ul>
    </li>
  );
}

// ── Data ─────────────────────────────────────────────────────

type Client = NonNullable<ReturnType<typeof useGatewayClient>["client"]>;

/** Subscribe to one gateway event and listen for it; returns the cleanup. */
function watchEvent(client: Client, event: string, listener: () => void): () => void {
  const subscribed = client.subscribe([event]).catch(() => undefined);
  const off = client.on(event, listener);
  return () => {
    off();
    void subscribed.then(() => client.unsubscribe([event])).catch(() => undefined);
  };
}

/** While the page is visible, the board refreshes this often (plus on open and on focus). */
const AUTO_REFRESH_MS = 2 * 60_000;
/** The server skips an automatic refresh when every source is younger than this. */
const AUTO_REFRESH_MAX_AGE_S = 60;

/** Call `onVisible` now, whenever the page comes back into view, and every `everyMs` while it's visible. */
function watchVisibility(onVisible: () => void, everyMs: number): () => void {
  const check = () => {
    if (document.visibilityState === "visible") onVisible();
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  const timer = setInterval(check, everyMs);
  check();
  return () => {
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("focus", check);
    clearInterval(timer);
  };
}

/** Each hop between extension, gateway and page re-wraps the message in another "Error: ". */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^(?:Error:\s*)+/, "");
}

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface TodayData {
  data: ListResponse | null;
  error: string | null;
  /** The Refresh button's collection is running. */
  refreshing: boolean;
  /** Something is reloading behind the board on screen (a cached one, or an automatic refresh). */
  syncing: boolean;
  refresh(): Promise<void>;
  pin(item: Item): void;
  dismiss(item: Item): void;
  /** Snooze a ticket (or a promise's ticket) in Linear until then; null unsnoozes. */
  snooze(item: Item, until: string | null): void;
  /** The Start button: opens the launch dialog for the item (see `LaunchDialog`). */
  launch(item: Item): void;
  /** The item the launch dialog is open for, or null. */
  pendingLaunch: Item | null;
  /** The Reviews page's "Review all" button: opens the launch dialog for the review queue. */
  reviewAll(): void;
  /** The open reviews the launch dialog is about to queue (2+), or null. */
  pendingQueue: Item[] | null;
  /** Start what the dialog is open for, with your note (blank for none) in its first prompt. */
  confirmLaunch(context: string): void;
  cancelLaunch(): void;
  /** Items starting a session right now. */
  launching: ReadonlySet<number>;
  /** Record a nudge for one of your PRs waiting on review (the button copies the draft). */
  nudge(item: Item): void;
  /** The Continue button: opens the dialog to send the item's session back to it. */
  follow(item: Item): void;
  /** The dialog is open to continue a session (`pendingLaunch`), not start one. */
  pendingFollow: boolean;
  /** Item sessions still in the attention queue, live. */
  sessions: ReadonlyMap<string, SessionSnapshot>;
  /** The open PR stack an item is in (bottom first), or null when it stands alone. */
  stackOf(item: Item): Item[] | null;
  /** the agent's text with its PR and ticket refs turned into links. */
  linked(text: string): ReactNode;
  /** The item's open question as a line to show under it, or null. */
  question(item: Item): ReactNode;
}

/** "Needs your answer: …" under an item whose session asked you something (`today.ask`). */
export function QuestionLine({ text }: { text: ReactNode }) {
  return (
    <p className="today-hand mt-1 rounded-xl bg-[#f3eafe] px-2.5 py-1 text-lg leading-tight text-[#6d28d9]">
      <span className="font-semibold">Needs your answer:</span> {text}
    </p>
  );
}

/** Open reviews no session works yet: what "Review all" queues (see `today.review_queue`). */
export function unstartedReviews(items: Item[]): Item[] {
  return items.filter((i) => i.section === "review" && i.status === "open" && !i.sessionId);
}

/** The Start button's props for one item. */
export function launchFor(today: TodayData, item: Item): LaunchProps {
  return {
    launching: today.launching.has(item.id),
    onLaunch: today.launch,
    sessions: today.sessions,
    // An app's PRs ready to promote are a group, not a stack: their card says how many.
    stackSize:
      item.section === "promote"
        ? undefined
        : (reviewStackOf(item)?.length ?? today.stackOf(item)?.length),
    onNudge: today.nudge,
    onContinue: today.follow,
  };
}

/** Text with some runs linked out (a PR, a ticket); links open a new tab. */
export function LinkedText({ text, link }: { text: string; link: RefLinker }) {
  return (
    <>
      {link(text).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <a
            key={i}
            href={part.url}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-[#e8b4a8] decoration-2 underline-offset-4 hover:decoration-current"
          >
            {part.text}
          </a>
        ),
      )}
    </>
  );
}

export function useToday(): TodayData {
  const { call, client, isConnected } = useGatewayClient();
  // The last board, at once: moving between pages (or reopening the app) never starts blank.
  const [data, setData] = useState<ListResponse | null>(() => cachedBoard());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [launching, setLaunching] = useState<ReadonlySet<number>>(new Set());
  const [pendingLaunch, setPendingLaunch] = useState<Item | null>(null);
  const [pendingQueue, setPendingQueue] = useState<Item[] | null>(null);
  const [pendingFollow, setPendingFollow] = useState(false);

  /** Count `work` as reloading behind the board while it runs. */
  const behind = useCallback(<T,>(work: Promise<T>): Promise<T> => {
    setInFlight((n) => n + 1);
    return work.finally(() => setInFlight((n) => n - 1));
  }, []);

  const load = useCallback(async () => {
    try {
      const board = await behind(call<ListResponse>("today.list", { doneSince: startOfToday() }));
      rememberBoard(board);
      setData(board);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [call, behind]);

  useEffect(() => {
    if (isConnected) void load();
  }, [isConnected, load]);

  // Live: a tick on the phone or a collection pass reloads every open page.
  const reload = useEffectEvent(() => void load());
  useEffect(() => {
    if (!client || !isConnected) return;
    return watchEvent(client, "today.changed", reload);
  }, [client, isConnected]);

  // Close to real time: a quiet refresh when you look. A collection reloads the page through
  // today.changed; a skipped one (collected under a minute ago) just re-reads the list.
  const autoRefresh = useEffectEvent(() => {
    behind(
      call<{ skipped: boolean }>(
        "today.refresh",
        { maxAgeSeconds: AUTO_REFRESH_MAX_AGE_S },
        { timeoutMs: 180_000 },
      ),
    )
      .then((result) => (result.skipped ? load() : undefined))
      .catch(() => undefined);
  });
  useEffect(() => {
    if (!isConnected) return;
    return watchVisibility(autoRefresh, AUTO_REFRESH_MS);
  }, [isConnected]);

  const act = useCallback(
    (method: string, params: Record<string, unknown>) => {
      call(method, params)
        .then(load)
        .catch((err: unknown) => setError(errorText(err)));
    },
    [call, load],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await call("today.refresh", {}, { timeoutMs: 180_000 });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRefreshing(false);
    }
  };

  const stacks = useMemo(() => {
    const byItem = new Map<number, Item[]>();
    for (const stack of prStacks(data?.items ?? [])) {
      for (const member of stack) byItem.set(member.id, stack);
    }
    return byItem;
  }, [data]);

  const start = (item: Item, context: string) => {
    // A stacked PR starts the whole stack's session: every PR in it spins.
    const ids = (stacks.get(item.id) ?? [item]).map((member) => member.id);
    setLaunching((current) => new Set([...current, ...ids]));
    const note = context.trim();
    // A worktree's bootstrap (fetch, CodeGraph sync) can take a few minutes.
    call("today.launch", { id: item.id, ...(note && { context: note }) }, { timeoutMs: 300_000 })
      .then(load)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() =>
        setLaunching((current) => {
          const next = new Set(current);
          for (const id of ids) next.delete(id);
          return next;
        }),
      );
  };

  // Continue: the session already exists, so this only sends a prompt.
  const followUp = (item: Item, context: string) => {
    const ids = [
      item.id,
      ...(stacks.get(item.id) ?? [])
        .filter((member) => member.sessionId === item.sessionId)
        .map((member) => member.id),
    ];
    setLaunching((current) => new Set([...current, ...ids]));
    const note = context.trim();
    call("today.follow_up", { id: item.id, ...(note && { context: note }) }, { timeoutMs: 60_000 })
      .then(load)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() =>
        setLaunching((current) => {
          const next = new Set(current);
          for (const id of ids) next.delete(id);
          return next;
        }),
      );
  };

  // Spins every review it takes on until the queue session is linked to them.
  const startQueue = (items: Item[], context: string) => {
    const ids = items.map((item) => item.id);
    setLaunching((current) => new Set([...current, ...ids]));
    const note = context.trim();
    call("today.review_queue", note ? { context: note } : {}, { timeoutMs: 120_000 })
      .then(load)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() =>
        setLaunching((current) => {
          const next = new Set(current);
          for (const id of ids) next.delete(id);
          return next;
        }),
      );
  };

  const attention = useAttentionSessions();
  const sessions = useMemo(
    () => new Map(attention.sessions.map((s) => [s.sessionId, s] as const)),
    [attention.sessions],
  );
  const link = useMemo(() => refLinker(data?.items ?? []), [data]);

  return {
    data,
    error,
    refreshing,
    syncing: inFlight > 0 && data !== null,
    refresh,
    pin: (item) => act("today.pin", { id: item.id, pinned: !item.pinned }),
    dismiss: (item) => act("today.dismiss", { id: item.id, by: "user" }),
    snooze: (item, until) => act("today.snooze", { id: item.id, until }),
    launch: (item) => {
      if (launching.has(item.id)) return;
      setPendingFollow(false);
      setPendingLaunch(item);
    },
    pendingLaunch,
    reviewAll: () => {
      const queue = unstartedReviews(data?.items ?? []);
      if (queue.length > 0 && !queue.some((item) => launching.has(item.id))) setPendingQueue(queue);
    },
    pendingQueue,
    confirmLaunch: (context) => {
      if (pendingLaunch) (pendingFollow ? followUp : start)(pendingLaunch, context);
      if (pendingQueue) startQueue(pendingQueue, context);
      setPendingLaunch(null);
      setPendingQueue(null);
      setPendingFollow(false);
    },
    cancelLaunch: () => {
      setPendingLaunch(null);
      setPendingQueue(null);
      setPendingFollow(false);
    },
    launching,
    nudge: (item) => act("today.nudge", { id: item.id }),
    follow: (item) => {
      if (launching.has(item.id)) return;
      setPendingFollow(true);
      setPendingLaunch(item);
    },
    pendingFollow,
    sessions,
    stackOf: (item) => stacks.get(item.id) ?? null,
    linked: (text) => <LinkedText text={text} link={link} />,
    question: (item) =>
      asking(item) && item.question ? (
        <QuestionLine text={<LinkedText text={item.question} link={link} />} />
      ) : null,
  };
}

export function StatusBar({ data, error }: { data: ListResponse | null; error: string | null }) {
  const paused = data?.githubPaused ?? null;
  // While paused, a rate-limit failure is old news: the pause note says it calmly.
  const failing = Object.entries(data?.collections ?? {}).filter(
    ([, c]) => !c.ok && !(paused && /rate limit/i.test(c.error ?? "")),
  );
  return (
    <>
      {paused && (
        <div className="mb-6 rounded-2xl border border-[var(--line)] bg-white/60 px-4 py-2.5 text-sm text-[var(--muted)]">
          GitHub is taking a breather until{" "}
          {new Date(paused.until).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
          , so you and your sessions keep the last {paused.remaining} API points this hour. PRs and
          reviews refresh after that.
        </div>
      )}
      {(error || failing.length > 0) && (
        <div className="mb-6 rounded-2xl border border-[#f3c9c2] bg-[#fff1ee] px-4 py-3 text-sm text-[#9b2c1f]">
          {error && <div>{error}</div>}
          {failing.map(([name, c]) => (
            <div key={name}>
              Couldn't read {name}: {c.error}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Each active project's place in its plan: the current phase, how many of your tickets are
 * left in it, the phases after it, and the tickets no phase holds yet. Linear decides all of it:
 * a favorited project is active, its milestones are the phases.
 */
export function PhasePlan({ lines }: { lines: PhaseLine[] }) {
  if (lines.length === 0) return null;
  return (
    <section className="mb-8 rounded-3xl bg-[#f3eafd] px-4 py-3">
      <h2 className="today-display mb-1.5 text-base font-semibold text-[#7e22ce]">Projects</h2>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={line.project} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold">{line.project}</span>
            {line.phase ? (
              <>
                <span className="text-[var(--muted)]">Phase {line.phase}</span>
                <Chip tone="purple">{line.left} left</Chip>
                {line.later.length > 0 && (
                  <span className="text-xs text-[var(--muted)]">then {line.later.join(", ")}</span>
                )}
              </>
            ) : (
              <span className="text-[var(--muted)]">no phase planned yet</span>
            )}
            {line.unphased > 0 && <Chip tone="gray">{line.unphased} not in a phase</Chip>}
          </li>
        ))}
      </ul>
    </section>
  );
}
