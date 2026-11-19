/**
 * Today — the overview, a live status board. A note from the agent, what a session needs you
 * for, the top picks (the morning's ranked queue, minus whatever has started waiting since),
 * everything waiting on someone else, then one tile per category with counts and a three-item
 * peek into each. Nothing is ticked off: items come and go with their sources.
 */

import type { ReactNode } from "react";
import { Hourglass, RotateCw, Ship } from "lucide-react";
import { navigate } from "@anima/ui";
import { appGroups } from "../stacks";
import {
  asking,
  type BoardContext,
  type Flag,
  type Item,
  nudgeOnly,
  nudgeReason,
  phaseLines,
  promoteFlag,
  rank,
  type SectionSummary,
  fallbackNote,
  greeting,
  liveReason,
  stackFlags,
  summarize,
  topPicks,
  type Unit,
  waitingFlag,
  waitingUnits,
} from "./model";
import { localDate, nudgeDue } from "../nudge";
import { LaunchDialog } from "./LaunchDialog";
import { CoffeeLoader } from "./loading";
import { sessionState } from "./links";
import {
  Chip,
  FlagChip,
  ItemLine,
  launchFor,
  PhasePlan,
  rise,
  StatusBar,
  TodayTheme,
  type TodayData,
  useToday,
} from "./ui";

function Header({
  refreshing,
  syncing,
  onRefresh,
  updated,
}: {
  refreshing: boolean;
  /** The board on screen is cached and a fresh one is on its way. */
  syncing: boolean;
  onRefresh(): void;
  updated?: string;
}) {
  const date = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <header className="mb-6 flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
      <span className="today-display text-base font-semibold tracking-wide text-[var(--ink)]">
        ☀️ Today
      </span>
      <div className="flex items-center gap-3">
        <span className="hidden sm:inline">{date}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title={syncing ? "Freshening up…" : updated ? `Updated ${updated}` : "Refresh"}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-white/70 px-3 py-1 text-xs hover:bg-white disabled:opacity-60"
        >
          <RotateCw
            size={11}
            className={refreshing || syncing ? "animate-spin [animation-duration:1.4s]" : ""}
          />
          {refreshing ? "Refreshing…" : (updated ?? "Refresh")}
        </button>
      </div>
    </header>
  );
}

function AgentNote({ note, doneToday }: { note: ReactNode; doneToday: number }) {
  return (
    <section {...rise(0)} className="today-rise relative mb-10">
      {/* washi tape */}
      <span
        aria-hidden
        className="absolute -top-3 left-10 z-10 h-6 w-24 -rotate-3 rounded-sm"
        style={{
          background: "repeating-linear-gradient(45deg, #f9c9c1cc 0 8px, #fbd9d2cc 8px 16px)",
        }}
      />
      <div className="today-card relative -rotate-[0.4deg] rounded-[28px] px-6 pb-5 pt-7 sm:px-9 sm:pt-8">
        <h1 className="today-display text-[28px] font-semibold leading-tight sm:text-4xl">
          {greeting()} <span aria-hidden>☀️</span>
        </h1>
        <p className="today-hand mt-3 text-[26px] leading-snug text-[#5b4a42] sm:text-[30px]">
          {note}
        </p>
        <div className="mt-2 flex items-end justify-between gap-3">
          <span className="text-sm text-[var(--muted)]">
            {doneToday > 0 ? `${doneToday} done today` : ""}
          </span>
          <span className="today-hand text-2xl text-[var(--accent)]">— your agent</span>
        </div>
      </div>
    </section>
  );
}

/** Everything a session is waiting on you for, right under the note. */
function NeedsYou({ items, today }: { items: Item[]; today: TodayData }) {
  if (items.length === 0) return null;
  return (
    <section {...rise(1)} className="today-rise mb-8">
      <h2 className="today-display mb-3 text-xl font-semibold text-[#6d28d9]">
        {items.length === 1
          ? "One thing needs your answer"
          : `${items.length} things need your answer`}
      </h2>
      <ul className="today-card space-y-1 rounded-2xl border-[#d8c4fb] px-3 py-1.5 sm:px-4 sm:py-2">
        {items.map((item) => (
          <ItemLine
            key={item.id}
            item={item}
            launch={launchFor(today, item)}
            question={today.question(item)}
            wrap
          />
        ))}
      </ul>
    </section>
  );
}

/** Why it's a pick: a nudge that's due says so; the morning's reason only for its own picks. */
function pickReason(unit: Unit, ctx: BoardContext): string | null {
  const { lead } = unit;
  if (nudgeDue(lead, ctx.date)) return nudgeReason(lead);
  return liveReason(unit, ctx.date);
}

function TopPicks({ units, ctx, today }: { units: Unit[]; ctx: BoardContext; today: TodayData }) {
  if (units.length === 0) return null;
  return (
    <section {...rise(1)} className="today-rise mb-10">
      <h2 className="today-display mb-3 text-xl font-semibold">
        If you only do {units.length === 1 ? "one thing" : `${units.length} things`}…
      </h2>
      <ol className="space-y-2">
        {units.map((unit, index) => {
          const reason = pickReason(unit, ctx);
          const flags = stackFlags(unit, ctx);
          return (
            <li
              key={unit.lead.id}
              className="today-card flex items-start gap-2 rounded-2xl px-3 py-1.5 sm:gap-3 sm:px-4 sm:py-2"
            >
              <span className="today-display mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#fde8e4] text-base font-semibold text-[#c2410c] sm:h-8 sm:w-8 sm:text-lg">
                {index + 1}
              </span>
              <ul className="min-w-0 flex-1">
                <ItemLine
                  item={unit.lead}
                  launch={launchFor(today, unit.lead)}
                  reason={reason && today.linked(reason)}
                  flags={flags.length > 0 ? flags : undefined}
                  onSnooze={today.snooze}
                  wrap
                />
              </ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** What a waiting line says: each stacked PR's wait, or its own (with "nudge due" first). */
function waitingFlags(unit: Unit, ctx: BoardContext): Flag[] {
  const stacked = stackFlags(unit, ctx);
  if (stacked.length > 0) return stacked;
  const wait = waitingFlag(unit.lead, ctx.now);
  if (!nudgeDue(unit.lead, ctx.date)) return [wait];
  return [{ tone: "amber", text: "nudge due", weight: 0 }, wait];
}

/** Everything blocked on someone else, right under the picks: who, and for how long. */
function Waiting({ units, ctx, today }: { units: Unit[]; ctx: BoardContext; today: TodayData }) {
  if (units.length === 0) return null;
  const due = units.filter((u) => nudgeOnly(u, ctx)).length;
  return (
    <section {...rise(2)} className="today-rise mb-10">
      <h2 className="today-display mb-3 flex items-baseline gap-2 text-xl font-semibold">
        <Hourglass size={17} className="self-center text-[#1d4ed8]" />
        Waiting on others{" "}
        <span className="text-base font-normal text-[var(--muted)]">
          · {units.length}
          {due > 0 && ` · ${due === 1 ? "one nudge" : `${due} nudges`} due`}
        </span>
      </h2>
      <ul className="today-card rounded-2xl px-3 py-1.5 sm:px-4 sm:py-2">
        {units.map((unit) => (
          <ItemLine
            key={unit.lead.id}
            item={unit.lead}
            launch={launchFor(today, unit.lead)}
            flags={waitingFlags(unit, ctx)}
            wrap
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Open items in a category whose session is busy right now (running, or setting up its
 * worktree): the same test as the row's "Working" pill, so the tile and the list agree.
 */
function workingCount(items: Item[], summary: SectionSummary, today: TodayData): number {
  return items.filter(
    (i) =>
      i.status === "open" &&
      i.section === summary.info.section &&
      i.sessionId &&
      sessionState(today.sessions.get(i.sessionId), asking(i)).busy,
  ).length;
}

function Tile({
  summary,
  index,
  working,
}: {
  summary: SectionSummary;
  index: number;
  /** Items a session is working on now: shown so a quiet tile doesn't read as idle. */
  working: number;
}) {
  const { info, headline, total, counts } = summary;
  const href = `/today/${info.slug}`;
  // Ready to promote counts apps: one promote ships all of an app's PRs.
  const apps = info.section === "promote" ? appGroups(headline).length : null;
  const sub =
    apps !== null
      ? apps === 1
        ? "app"
        : "apps"
      : total > headline.length
        ? info.section === "ticket"
          ? `of ${total} assigned`
          : `of ${total} open`
        : headline.length === 1
          ? "item"
          : "items";
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
      {...rise(index + 2)}
      className="today-rise today-tile block rounded-3xl p-4"
      style={{ ...rise(index + 2).style, background: info.tint }}
    >
      <div className="flex items-center justify-between">
        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white/80 text-xl shadow-sm">
          {info.emoji}
        </span>
        <span className="text-xs font-semibold" style={{ color: info.accent }}>
          {info.label}
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span
          className="today-display text-4xl font-semibold leading-none"
          style={{ color: info.accent }}
        >
          {apps ?? headline.length}
        </span>
        <span className="text-xs text-[var(--muted)]">{sub}</span>
      </div>
      <div className="mt-2.5 flex min-h-[22px] flex-wrap gap-1">
        {apps !== null ? (
          // The PRs behind the apps, and how many have waited 3 days or more (amber).
          <>
            {headline.length > 0 && (
              <Chip tone="purple">
                {headline.length} PR{headline.length === 1 ? "" : "s"}
              </Chip>
            )}
            {counts.amber > 0 && <Chip tone="amber">{counts.amber} over 3 days</Chip>}
            {working > 0 && <Chip tone="blue">{working} shipping</Chip>}
          </>
        ) : info.section === "my_pr" ? (
          // Every headlined PR is actionable: green ones can merge, the rest need work.
          <>
            {counts.green > 0 && <Chip tone="green">{counts.green} ready to merge</Chip>}
            {headline.length > counts.green && (
              <Chip tone="amber">{headline.length - counts.green} need work</Chip>
            )}
            {working > 0 && <Chip tone="blue">{working} working</Chip>}
          </>
        ) : (
          <>
            {counts.red > 0 && <Chip tone="red">{counts.red} now</Chip>}
            {counts.amber > 0 && <Chip tone="amber">{counts.amber} soon</Chip>}
            {counts.waiting > 0 && <Chip tone="amber">{counts.waiting} waiting</Chip>}
            {counts.green > 0 && <Chip tone="green">{counts.green} ready</Chip>}
            {working > 0 && <Chip tone="blue">{working} working</Chip>}
            {counts.red + counts.amber + counts.waiting + counts.green + working === 0 &&
              headline.length > 0 && <Chip tone="gray">all calm</Chip>}
          </>
        )}
      </div>
    </a>
  );
}

function Peek({
  summary,
  index,
  today,
}: {
  summary: SectionSummary;
  index: number;
  today: TodayData;
}) {
  const { info, headline } = summary;
  const href = `/today/${info.slug}`;
  if (info.section === "promote") return <PromotePeek summary={summary} index={index} />;
  return (
    <section {...rise(index + 8)} className="today-rise today-card min-w-0 rounded-3xl px-5 py-4">
      <header className="mb-1 flex items-center justify-between">
        <h3 className="today-display text-lg font-semibold">
          <span className="mr-1.5">{info.emoji}</span>
          {info.label}
        </h3>
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            navigate(href);
          }}
          className="text-xs font-semibold hover:underline"
          style={{ color: info.accent }}
        >
          {headline.length > 3 ? `See all ${headline.length} →` : "Open →"}
        </a>
      </header>
      <ul>
        {headline.slice(0, 3).map((item) => (
          <ItemLine
            key={item.id}
            item={item}
            onSnooze={today.snooze}
            launch={launchFor(today, item)}
          />
        ))}
      </ul>
    </section>
  );
}

/** Ready to promote on the overview: one line per app, with its PR count and oldest wait. */
function PromotePeek({ summary, index }: { summary: SectionSummary; index: number }) {
  const { info, headline } = summary;
  const href = `/today/${info.slug}`;
  const groups = appGroups(headline);
  return (
    <section {...rise(index + 8)} className="today-rise today-card min-w-0 rounded-3xl px-5 py-4">
      <header className="mb-1 flex items-center justify-between">
        <h3 className="today-display text-lg font-semibold">
          <span className="mr-1.5">{info.emoji}</span>
          {info.label}
        </h3>
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            navigate(href);
          }}
          className="text-xs font-semibold hover:underline"
          style={{ color: info.accent }}
        >
          Open →
        </a>
      </header>
      <ul>
        {groups.map((members) => {
          const { app, promoteUrl } = (members[0]!.meta ?? {}) as Record<string, string>;
          const flag = promoteFlag(members);
          return (
            <li key={members[0]!.id} className="flex items-center gap-2 py-1.5">
              <Ship size={14} className="shrink-0 text-[#0f766e]" />
              <span className="min-w-0 truncate text-[15px]">{app}</span>
              {/* The chip carries the count and the oldest wait; the name is already beside it. */}
              <FlagChip flag={{ ...flag, text: flag.text.slice(`${app} · `.length) }} />
              <span className="flex-1" />
              {promoteUrl && (
                <a
                  href={promoteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-[#0f766e] hover:underline"
                >
                  promote ↗
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function TodayPage() {
  const today = useToday();
  const { data } = today;
  const summaries = data ? summarize(data.items) : [];
  const ctx: BoardContext = {
    date: data?.date ?? localDate(new Date()),
    now: new Date(),
    live: today.sessions,
    stackOf: today.stackOf,
  };
  const top = data ? topPicks(data.items, ctx) : [];
  const waiting = data ? waitingUnits(data.items, ctx, top) : [];
  const doneToday = data?.items.filter((i) => i.status !== "open").length ?? 0;
  const updated = Object.values(data?.collections ?? {})
    .map((c) => c.at)
    .sort()
    .at(-1);
  const updatedText = updated
    ? new Date(updated).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : undefined;

  return (
    <TodayTheme>
      <Header
        refreshing={today.refreshing}
        syncing={today.syncing}
        onRefresh={() => void today.refresh()}
        updated={updatedText}
      />
      <StatusBar data={data} error={today.error} />
      {!data && !today.error && <CoffeeLoader />}
      {data && (
        <>
          <AgentNote
            note={today.linked(data.note ?? fallbackNote(summaries))}
            doneToday={doneToday}
          />
          <NeedsYou items={rank(data.items.filter(asking))} today={today} />
          <TopPicks units={top} ctx={ctx} today={today} />
          <Waiting units={waiting} ctx={ctx} today={today} />
          <PhasePlan lines={phaseLines(data.items)} />
          <section className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {summaries.map((summary, index) => (
              <Tile
                key={summary.info.slug}
                summary={summary}
                index={index}
                working={workingCount(data.items, summary, today)}
              />
            ))}
          </section>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {summaries
              .filter((s) => s.headline.length > 0)
              .map((summary, index) => (
                <Peek key={summary.info.slug} summary={summary} index={index} today={today} />
              ))}
          </div>
        </>
      )}
      <LaunchDialog today={today} />
    </TodayTheme>
  );
}
