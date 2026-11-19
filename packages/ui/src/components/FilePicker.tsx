import React, { useEffect, useRef } from "react";

interface FilePickerProps {
  isOpen: boolean;
  /**
   * Pre-filtered results — parent owns the filter so it doesn't run when the
   * picker is closed.
   */
  filtered: FilteredFile[];
  /** Currently highlighted index into `filtered`. */
  selectedIndex: number;
  onSelectedIndexChange(index: number): void;
  onPick(path: string): void;
}

export interface FilteredFile {
  /** Path from the workspace root. A directory ends in `/`. */
  path: string;
  matchIndices: ReadonlyArray<number>;
}

/** Cap how many results we render — keeps the picker snappy on huge repos. */
const MAX_RESULTS = 50;

/** Lower-cased copies of each file list, so a keystroke doesn't re-lowercase 50k paths. */
const lowerCache = new WeakMap<string[], string[]>();

function lowered(files: string[]): string[] {
  let lower = lowerCache.get(files);
  if (!lower) {
    lower = files.map((f) => f.toLowerCase());
    lowerCache.set(files, lower);
  }
  return lower;
}

/**
 * Complete a path one directory at a time, like a shell's tab completion.
 *
 * The query is a path from the workspace root. Everything up to its last `/`
 * must match a directory exactly (ignoring case); the rest is a prefix of the
 * entries inside it. `cl` lists `clients/`, `clients/` lists what's in it,
 * `clients/vs` narrows that. Directories come back with a trailing `/` and
 * sort before files.
 *
 * No fuzzy matching on purpose: text that isn't the start of a real path
 * (`@mention` followed by a paragraph) matches nothing within a letter or two,
 * which closes the picker instead of searching on every keystroke.
 */
export function filterFiles(files: string[], query: string): FilteredFile[] {
  const q = query.startsWith("./") ? query.slice(2) : query;
  const lowerQuery = q.toLowerCase();
  const slash = lowerQuery.lastIndexOf("/");
  const dir = lowerQuery.slice(0, slash + 1);
  const name = lowerQuery.slice(slash + 1);

  const lower = lowered(files);
  const entries = new Map<string, boolean>(); // path → isDirectory
  for (let i = 0; i < files.length; i++) {
    const path = lower[i];
    if (!path.startsWith(dir)) continue;
    const next = path.indexOf("/", dir.length);
    const segment = next < 0 ? path.slice(dir.length) : path.slice(dir.length, next);
    if (!segment.startsWith(name)) continue;
    // Keep the path's real casing for what gets inserted.
    const entry = next < 0 ? files[i] : files[i].slice(0, next + 1);
    entries.set(entry, next >= 0);
  }

  const highlight = Array.from({ length: q.length }, (_, i) => i);
  return [...entries]
    .sort(([a, aDir], [b, bDir]) =>
      aDir === bDir ? a.toLowerCase().localeCompare(b.toLowerCase()) : aDir ? -1 : 1,
    )
    .slice(0, MAX_RESULTS)
    .map(([path]) => ({ path, matchIndices: highlight }));
}

function highlightPath(path: string, indices: ReadonlyArray<number>): React.ReactElement[] {
  if (indices.length === 0) return [<span key="full">{path}</span>];
  const indexSet = new Set(indices);
  const out: React.ReactElement[] = [];
  let buf = "";
  let bufHit = false;
  for (let i = 0; i < path.length; i++) {
    const isHit = indexSet.has(i);
    if (i === 0) {
      buf = path[i];
      bufHit = isHit;
      continue;
    }
    if (isHit === bufHit) {
      buf += path[i];
    } else {
      out.push(
        bufHit ? (
          <span key={`${out.length}-h`} className="text-blue-600 font-semibold">
            {buf}
          </span>
        ) : (
          <span key={`${out.length}-p`}>{buf}</span>
        ),
      );
      buf = path[i];
      bufHit = isHit;
    }
  }
  if (buf.length > 0) {
    out.push(
      bufHit ? (
        <span key={`${out.length}-h`} className="text-blue-600 font-semibold">
          {buf}
        </span>
      ) : (
        <span key={`${out.length}-p`}>{buf}</span>
      ),
    );
  }
  return out;
}

/** Split a path into `{ dir, base }` for two-tone rendering (dir muted, base bold). */
function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { dir: "", base: path };
  return { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

export function FilePicker({
  isOpen,
  filtered,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
}: FilePickerProps) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLLIElement>(`[data-file-index="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex]);

  // Nothing matching means the `@` wasn't a path: stay out of the way.
  if (!isOpen || filtered.length === 0) return null;

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-2 z-30 rounded-lg border border-gray-200 bg-white/95 backdrop-blur shadow-lg overflow-hidden"
      role="listbox"
      aria-label="File picker"
    >
      <ul ref={listRef} className="max-h-72 overflow-auto py-1 pl-0 m-0 list-none">
        {filtered.map((entry, idx) => {
          const isSelected = idx === selectedIndex;
          const { dir, base } = splitPath(entry.path);
          // Highlight indices apply to the full path; we just render base+dir
          // adjacent and let the highlighter span them (highlights are cosmetic).
          return (
            <li
              key={entry.path}
              data-file-index={idx}
              role="option"
              aria-selected={isSelected}
              onMouseEnter={() => onSelectedIndexChange(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(entry.path);
              }}
              className={`px-3 py-2 cursor-pointer text-sm flex items-baseline gap-1 ${
                isSelected ? "bg-blue-50" : "hover:bg-gray-50"
              }`}
            >
              <span className="font-mono text-gray-800 truncate">
                {entry.matchIndices.length > 0 ? (
                  highlightPath(entry.path, entry.matchIndices)
                ) : (
                  <>
                    <span className="text-gray-400">{dir}</span>
                    <span>{base}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
