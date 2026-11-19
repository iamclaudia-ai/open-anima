/**
 * `pgrep -f` pattern for this checkout's extension hosts: the absolute path
 * the gateway spawns them with (`<root>/extensions/<id>/src/index.ts`).
 * Anchored to this checkout, so a second Anima on the same machine (another
 * clone, another worktree) never has its extension hosts killed by this one.
 */
export function orphanExtensionHostPattern(rootDir: string): string {
  const escaped = rootDir.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Preceded by the start of the command line or a space, so `/x/anima` never
  // matches inside `/y/x/anima`.
  return `(^| )${escaped}/extensions/[^/ ]+/src/index\\.ts`;
}
