/**
 * Persona selection.
 *
 * `agentHost.persona` in anima.json names the persona every Claude session
 * starts with. It is either:
 *
 * - a **name** (`"lumen"`): looked up as `<configHome>/.anima/personas/<name>.md`
 *   first, so your own personas live next to your config, then in the repo's
 *   shipped `personas/` folder;
 * - a **path** (anything with a `/` or ending in `.md`; `~/` expands): used as is;
 * - `"none"` (or an empty string): no persona, just Claude Code's own prompt.
 *
 * Unset means `"lumen"`, the general-purpose persona that ships in `personas/`.
 * See docs/PERSONAS.md for how to write your own.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { animaConfigHome, animaLogFile, createLogger } from "@anima/shared";

const log = createLogger("Persona", animaLogFile("agent-host.log"));

export const DEFAULT_PERSONA = "lumen";

/** The repo's shipped personas: `<repo>/personas`. */
export const SHIPPED_PERSONAS_DIR = resolve(import.meta.dir, "..", "..", "..", "personas");

export interface PersonaLookup {
  /** Folder that holds `.anima/` (defaults to `$ANIMA_HOME` or the home folder). */
  configHome?: string;
  /** Folder of shipped personas (defaults to the repo's `personas/`). */
  shippedDir?: string;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isPath(value: string): boolean {
  return value.includes("/") || value.endsWith(".md");
}

/**
 * The persona file to load, or undefined for no persona. A name or path that
 * resolves to nothing is logged and treated as no persona: a typo in the
 * config must not stop every session from starting.
 */
export function resolvePersonaFile(
  persona: string | undefined,
  lookup: PersonaLookup = {},
): string | undefined {
  const value = (persona ?? DEFAULT_PERSONA).trim();
  if (!value || value.toLowerCase() === "none") return undefined;

  if (isPath(value)) {
    const path = expandHome(value);
    if (existsSync(path)) return path;
    log.warn("Persona file not found, starting without a persona", { path });
    return undefined;
  }

  const configHome = lookup.configHome ?? animaConfigHome();
  const candidates = [
    join(configHome, ".anima", "personas", `${value}.md`),
    join(lookup.shippedDir ?? SHIPPED_PERSONAS_DIR, `${value}.md`),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    log.warn("Persona not found, starting without a persona", { persona: value, candidates });
  }
  return found;
}
