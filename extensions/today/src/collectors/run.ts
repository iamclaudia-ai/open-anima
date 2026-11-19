/**
 * Runs a collector's command line. Injected so tests never spawn anything.
 *
 * Extensions inherit the watchdog's captured login PATH, so `gh` and `jq` resolve as they do
 * in your shell (the bundled scripts are run by absolute path). `cwd` is the project folder,
 * which matters when your `gh` picks its account by folder.
 */

export type RunCommand = (
  argv: string[],
  options: { cwd?: string; timeoutMs?: number },
) => Promise<string>;

export const runCommand: RunCommand = async (argv, { cwd, timeoutMs = 60_000 }) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        // Name the call, not just the tool: one collector runs dozens of `gh api` requests.
        `${argv.slice(0, 4).join(" ").slice(0, 160)} exited ${code}: ${stderr.trim().slice(0, 500) || stdout.slice(0, 200)}`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
};
