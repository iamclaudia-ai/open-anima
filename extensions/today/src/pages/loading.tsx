/**
 * What the Today pages show while they wait: a mug of coffee filling up (with steam rising)
 * the first time the board loads, a small "freshening up" badge while a cached board
 * refreshes behind the page, and the agent's note on each category page.
 */

import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import type { Section } from "./model";
import { LOADING_LINES, lastNote, noteShown, sectionNote } from "./notes";

const CSS = `
@keyframes today-fill { from { transform: translateY(46px); } to { transform: translateY(0); } }
@keyframes today-wave { from { transform: translateX(-36px); } to { transform: translateX(0); } }
@keyframes today-pour { 0% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
@keyframes today-steam {
  0% { stroke-dashoffset: 30; opacity: 0; }
  30% { opacity: .9; }
  100% { stroke-dashoffset: -30; opacity: 0; }
}
@keyframes today-caption { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes today-appear { from { opacity: 0; } to { opacity: 1; } }
.today-coffee { animation: today-fill 2.4s cubic-bezier(.3,.6,.3,1) forwards; }
.today-wave { animation: today-wave 1.6s linear infinite; }
.today-pour { animation: today-pour 2.4s ease-in forwards; }
.today-steam path { stroke-dasharray: 30 30; animation: today-steam 2.6s ease-in-out infinite both; }
.today-steam path:nth-child(2) { animation-delay: 1.9s; }
.today-steam path:nth-child(3) { animation-delay: 2.6s; }
.today-steam path:nth-child(1) { animation-delay: 1.2s; }
.today-caption { animation: today-caption .4s ease both; }
/* Quick refreshes never show the badge: it fades in only after a beat. */
.today-sync { animation: today-appear .3s ease .4s both; }
@media (prefers-reduced-motion: reduce) {
  .today-coffee, .today-wave, .today-pour, .today-steam path, .today-caption, .today-sync { animation: none; }
  .today-pour { opacity: 0; }
}
`;

const MUG = "M30 52 h52 v30 a16 16 0 0 1 -16 16 h-20 a16 16 0 0 1 -16 -16 z";

/** The first load: a mug filling with coffee, rising steam, and a rotating caption. */
export function CoffeeLoader() {
  const [line, setLine] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setLine((n) => (n + 1) % LOADING_LINES.length), 2_200);
    return () => clearInterval(timer);
  }, []);
  return (
    <div role="status" className="flex flex-col items-center py-14">
      <style>{CSS}</style>
      <svg viewBox="0 0 120 112" width="132" height="124" aria-hidden>
        <defs>
          <clipPath id="today-mug-inside">
            <path d={MUG} />
          </clipPath>
        </defs>
        {/* the pour, from the top until the cup is full */}
        <rect className="today-pour" x="54" y="0" width="5" height="70" rx="2.5" fill="#8a5637" />
        <g
          className="today-steam"
          fill="none"
          stroke="#cdb9aa"
          strokeWidth="3"
          strokeLinecap="round"
        >
          <path d="M45 44 c-6 -7 6 -11 0 -19 s6 -11 0 -19" />
          <path d="M57 44 c-6 -7 6 -11 0 -19 s6 -11 0 -19" />
          <path d="M69 44 c-6 -7 6 -11 0 -19 s6 -11 0 -19" />
        </g>
        <ellipse cx="56" cy="102" rx="38" ry="5" fill="#efe4d8" />
        <path d={MUG} fill="#fffdf9" />
        <g clipPath="url(#today-mug-inside)">
          <g className="today-coffee">
            <g className="today-wave">
              <path
                d="M0 58 q9 -5 18 0 t18 0 t18 0 t18 0 t18 0 t18 0 t18 0 v50 h-126 z"
                fill="#a0694a"
              />
              <path
                d="M0 61 q9 -5 18 0 t18 0 t18 0 t18 0 t18 0 t18 0 t18 0"
                stroke="#c48a63"
                strokeWidth="2"
                fill="none"
              />
            </g>
          </g>
        </g>
        <path d={MUG} fill="none" stroke="#2d2622" strokeWidth="3" strokeLinejoin="round" />
        <path
          d="M82 60 h5 a10 10 0 0 1 0 20 h-6"
          fill="none"
          stroke="#2d2622"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <p key={line} className="today-hand today-caption mt-3 text-2xl text-[var(--muted)]">
        {LOADING_LINES[line]}
      </p>
    </div>
  );
}

/** A cached board on screen while the fresh one loads behind it. */
export function SyncBadge({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span
      role="status"
      className="today-sync inline-flex items-center gap-1.5 text-xs text-[var(--muted)]"
    >
      <style>{CSS}</style>
      <RotateCw size={12} className="animate-spin [animation-duration:1.4s]" />
      freshening up
    </span>
  );
}

/**
 * The agent's note at the top of a category page. Mount it with `key={section}`: the note is
 * picked once per visit, and never the one the last visit showed.
 */
export function SectionNote({ section, count }: { section: Section; count: number }) {
  const [seed] = useState(Math.random);
  const [avoid] = useState(() => lastNote(section));
  const note = sectionNote(section, count, seed, avoid);
  useEffect(() => noteShown(section, note), [section, note]);
  return (
    <p className="today-hand today-rise mb-6 -rotate-[0.3deg] text-[22px] leading-snug text-[#5b4a42] sm:text-2xl">
      {note} <span className="text-[var(--accent)]">— your agent</span>
    </p>
  );
}
