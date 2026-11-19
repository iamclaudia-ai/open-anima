/**
 * Today — one category in full (/today/<slug>): what needs you first,
 * everything else in the category behind "show everything" (PRs waiting on
 * someone else stay listed, dimmed), then tickets and promises already in
 * progress or review (their PRs carry them), and what you finished today at the bottom.
 */

import { useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { navigate } from "@anima/ui";
import {
  flagFor,
  inFlight,
  type Item,
  needsAttention,
  phaseLines,
  rank,
  sectionBySlug,
} from "./model";
import { snoozedUntil } from "../snooze";
import { LaunchDialog } from "./LaunchDialog";
import { CoffeeLoader, SectionNote, SyncBadge } from "./loading";
import {
  ItemRow,
  launchFor,
  PhasePlan,
  PromoteCard,
  rise,
  StackCard,
  StatusBar,
  type TodayData,
  TodayTheme,
  unstartedReviews,
  useToday,
} from "./ui";

/** "Review all": one review-queue session works every review no session has yet, one after another. */
function ReviewAllButton({ today }: { today: TodayData }) {
  const queue = unstartedReviews(today.data?.items ?? []);
  const starting = queue.some((item) => today.launching.has(item.id));
  if (queue.length < 2 && !starting) return null;
  return (
    <button
      type="button"
      onClick={today.reviewAll}
      disabled={starting}
      title="One session orders the queue, then reviews each PR (or stack) in turn, handing off to a fresh session for the next"
      className="today-check inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[#cddcfb] bg-white/70 px-3 text-[13px] font-semibold text-[var(--accent)] hover:bg-[#e2ebff] disabled:opacity-70"
    >
      {starting ? (
        <LoaderCircle size={14} className="animate-spin" />
      ) : (
        <Play size={11} strokeWidth={2.5} className="fill-current" />
      )}
      Review all {queue.length}
    </button>
  );
}

export function TodaySectionPage({ section }: { section?: string }) {
  const info = sectionBySlug(section);
  const today = useToday();
  const [everything, setEverything] = useState(false);
  const { data } = today;

  const back = (
    <div className="mb-6 flex items-center justify-between gap-3">
      <a
        href="/today"
        onClick={(e) => {
          e.preventDefault();
          navigate("/today");
        }}
        className="text-sm text-[var(--muted)] hover:text-[var(--ink)]"
      >
        ← Today
      </a>
      <SyncBadge active={today.syncing} />
    </div>
  );

  if (!info) {
    return (
      <TodayTheme>
        {back}
        <p className="today-hand text-2xl">I don't know that page.</p>
      </TodayTheme>
    );
  }

  const inSection = (data?.items ?? []).filter((i) => i.section === info.section);
  const open = inSection.filter((i) => i.status === "open");
  const headline = rank(open.filter((i) => needsAttention(i)));
  // Snoozed: out of the way, listed at the end so they can be unsnoozed.
  const snoozed = open
    .filter((i) => snoozedUntil(i))
    .sort((a, b) => String(a.meta?.snoozedUntil).localeCompare(String(b.meta?.snoozedUntil)));
  const awake = open.filter((i) => !snoozedUntil(i));
  // Started tickets and promises: their PRs carry them, listed after what's left to start.
  const started = rank(awake.filter((i) => inFlight(i)));
  const rest = rank(awake.filter((i) => !needsAttention(i) && !inFlight(i)));
  const done = inSection.filter((i) => i.status !== "open");
  const showProject = new Set(inSection.map((i) => i.project)).size > 1;
  // PRs that wait on someone else stay in view, dimmed, instead of behind "show the other N".
  const prs = info.section === "my_pr";
  const ready = prs ? headline.filter((i) => flagFor(i)?.tone === "green").length : 0;
  const row = (item: Item, index: number, dim = false) => (
    <div key={item.id} {...rise(index)}>
      <ItemRow
        item={item}
        showProject={showProject}
        onSnooze={today.snooze}
        onPin={today.pin}
        onDismiss={today.dismiss}
        launch={launchFor(today, item)}
        reason={item.topReason && today.linked(item.topReason)}
        question={today.question(item)}
        dim={dim && !item.question}
      />
    </div>
  );
  // A PR stack is one card, placed where its most urgent PR ranks.
  const shown = new Set<Item[]>();
  const rows = (ranked: Item[], dim = false) =>
    ranked.flatMap((item, index) => {
      const stack = today.stackOf(item);
      if (!stack) return [row(item, index, dim)];
      if (shown.has(stack)) return [];
      shown.add(stack);
      return [
        <div key={`stack-${stack[0]!.id}`} {...rise(index)}>
          {stack[0]!.section === "promote" ? (
            <PromoteCard members={stack} today={today} showProject={showProject} />
          ) : (
            <StackCard
              members={stack}
              today={today}
              showProject={showProject}
              dim={dim && !stack.some((m) => m.question)}
            />
          )}
        </div>,
      ];
    });
  // Ready to promote: one card per app (a group), so count the apps as well as the PRs.
  const apps = new Set(headline.map((i) => `${String(i.meta?.repo)}:${String(i.meta?.app)}`));
  // Headline first: a stack with anything that needs you belongs up there, whole.
  const headlineRows = rows(headline);
  const waiting = prs ? rows(rest, true) : [];
  const summary = prs
    ? [
        ready > 0 && `${ready} ready to merge`,
        headline.length > ready && `${headline.length - ready} need work`,
        rest.length > 0 && `${rest.length} waiting on others`,
      ]
        .filter(Boolean)
        .join(" · ") || "Nothing open"
    : [
        info.section === "promote"
          ? `${apps.size} app${apps.size === 1 ? "" : "s"} · ${headline.length} PR${headline.length === 1 ? "" : "s"} waiting on a promote`
          : info.section === "ticket" || info.section === "promise"
            ? `${headline.length} to start`
            : `${headline.length} need${headline.length === 1 ? "s" : ""} you`,
        rest.length > 0 && `${rest.length} more open`,
        started.length > 0 && `${started.length} in progress or review`,
        snoozed.length > 0 && `${snoozed.length} snoozed`,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <TodayTheme>
      {back}
      <header className="mb-6 flex items-center gap-3">
        <span
          className="grid h-12 w-12 place-items-center rounded-2xl text-2xl"
          style={{ background: info.tint }}
        >
          {info.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="today-display text-3xl font-semibold leading-tight">{info.label}</h1>
          {/* Before the first board arrives there is nothing to count: no "0 need you". */}
          <p className="text-sm text-[var(--muted)]">{data ? summary : "\u00a0"}</p>
        </div>
        {info.section === "review" && <ReviewAllButton today={today} />}
      </header>
      <StatusBar data={data} error={today.error} />
      {!data && !today.error && <CoffeeLoader />}
      {data && <SectionNote key={info.section} section={info.section} count={headline.length} />}
      {info.section === "ticket" && data && <PhasePlan lines={phaseLines(data.items)} />}
      <ul className="space-y-2.5">{headlineRows}</ul>
      {prs && waiting.length > 0 && (
        <div className="mt-8">
          <h2 className="today-display mb-2 text-lg font-semibold text-[var(--muted)]">
            Waiting on others
          </h2>
          <ul className="space-y-2.5">{waiting}</ul>
        </div>
      )}
      {!prs && rest.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setEverything(!everything)}
            className="text-sm font-semibold hover:underline"
            style={{ color: info.accent }}
          >
            {everything ? "Hide the rest" : `Show the other ${rest.length}`}
          </button>
          {everything && (
            <ul className="mt-3 space-y-2.5">{rest.map((item, i) => row(item, i))}</ul>
          )}
        </div>
      )}
      {started.length > 0 && (
        <div className="mt-8">
          <h2 className="today-display text-lg font-semibold text-[var(--muted)]">
            In progress or review
          </h2>
          <p className="mb-2 text-xs text-[var(--muted)]">Their PRs are in Your PRs.</p>
          <ul className="space-y-2.5">{started.map((item, i) => row(item, i, true))}</ul>
        </div>
      )}
      {snoozed.length > 0 && (
        <div className="mt-8">
          <h2 className="today-display mb-2 text-lg font-semibold text-[var(--muted)]">
            Snoozed 💤
          </h2>
          <ul className="space-y-2.5">{snoozed.map((item, i) => row(item, i, true))}</ul>
        </div>
      )}
      {done.length > 0 && (
        <div className="mt-10">
          <h2 className="today-display mb-2 text-lg font-semibold text-[var(--muted)]">
            Done today ✨
          </h2>
          <ul className="space-y-2.5">{done.map((item, i) => row(item, i))}</ul>
        </div>
      )}
      <LaunchDialog today={today} />
    </TodayTheme>
  );
}
