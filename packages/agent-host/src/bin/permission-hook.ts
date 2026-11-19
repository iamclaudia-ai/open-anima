/**
 * Claude Code `PermissionRequest` hook for Anima's CLI sessions.
 *
 * Registered through the `--settings` file agent-host passes to every CLI
 * session. It forwards the request to agent-host and waits, holding one HTTP
 * request open, until someone answers it from Anima; the answer is printed as
 * the hook's decision. The dialog stays up in the pane meanwhile, so answering
 * there still works: Claude Code then sends this process SIGTERM, which drops
 * the connection, which tells agent-host the prompt was settled.
 *
 * Every failure path exits 0 without output, which leaves the decision to the
 * dialog: this hook must never be the reason a prompt can't be answered.
 * Deliberately dependency-free, since it starts on every permission prompt.
 */

import { randomUUID } from "node:crypto";

const url = process.env.ANIMA_PERMISSION_HOOK_URL;
const token = process.env.ANIMA_PERMISSION_HOOK_TOKEN;
const sessionId = process.env.ANIMA_SESSION_ID;

/** How long to keep trying while agent-host is down or restarting. */
const UNREACHABLE_GIVE_UP_MS = 5 * 60_000;
const RETRY_MS = 1_000;

function leaveToDialog(): never {
  process.exit(0);
}

if (!url || !token || !sessionId) leaveToDialog();

const abort = new AbortController();
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    abort.abort();
    leaveToDialog();
  });
}

let input: unknown;
try {
  input = JSON.parse(await Bun.stdin.text());
} catch {
  leaveToDialog();
}

// One id for the whole wait, so a re-ask after an agent-host restart lands on
// the same card instead of adding a second one.
const body = JSON.stringify({ sessionId, requestId: randomUUID(), input });
let unreachableSince: number | null = null;

while (true) {
  try {
    const res = await fetch(url!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
      signal: abort.signal,
    });
    unreachableSince = null;
    // 503: this agent-host is shutting down; ask the next one.
    if (res.status === 503) {
      await Bun.sleep(RETRY_MS);
      continue;
    }
    if (!res.ok) leaveToDialog();
    const reply = (await res.json()) as { decision?: unknown; retry?: boolean };
    if (reply.retry) {
      await Bun.sleep(RETRY_MS);
      continue;
    }
    if (!reply.decision) leaveToDialog();
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: reply.decision },
      }),
    );
    process.exit(0);
  } catch {
    if (abort.signal.aborted) leaveToDialog();
    unreachableSince ??= Date.now();
    if (Date.now() - unreachableSince > UNREACHABLE_GIVE_UP_MS) leaveToDialog();
    await Bun.sleep(RETRY_MS);
  }
}
