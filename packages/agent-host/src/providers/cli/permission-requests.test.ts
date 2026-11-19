import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectModalPrompt, type ModalPrompt } from "./modal-prompt";
import {
  DECLINED,
  describeToolInput,
  type ClearReason,
  type HookReply,
  hookFingerprint,
  PermissionRequests,
  type PermissionRequestInput,
} from "./permission-requests";
import {
  parsePermissionHookRequest,
  permissionHookToken,
  verifyPermissionHookToken,
} from "./permission-hook";

/** The real dialog for a hook-gated Bash call (Claude Code 2.1.322, 220 columns). */
const DIALOG = detectModalPrompt(
  readFileSync(join(import.meta.dir, "fixtures", "modal-countdown-220.txt"), "utf8"),
)!;

function harness() {
  const announced: ModalPrompt[] = [];
  const cleared: Array<{ fingerprint: string; reason: ClearReason; answered?: string }> = [];
  const requests = new PermissionRequests({
    announce: (prompt) => announced.push(prompt),
    cleared: (fingerprint, reason, answered) => cleared.push({ fingerprint, reason, answered }),
  });
  return { requests, announced, cleared };
}

function bash(
  requestId: string,
  extra: Partial<PermissionRequestInput> = {},
): PermissionRequestInput {
  return {
    requestId,
    toolName: "Bash",
    toolInput: { command: "git push --force-with-lease", description: "Push the branch" },
    permissionMode: "bypassPermissions",
    ...extra,
  };
}

/** Settled replies, readable synchronously. */
function track(promise: Promise<HookReply>): { reply?: HookReply } {
  const box: { reply?: HookReply } = {};
  void promise.then((r) => (box.reply = r));
  return box;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PermissionRequests", () => {
  test("announces a request as an approval card with Yes and No", () => {
    const { requests, announced } = harness();
    void requests.request(bash("req-00000001"));
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({
      kind: "approval",
      fingerprint: hookFingerprint("req-00000001"),
      context: ["Bash command", "Push the branch", "git push --force-with-lease"],
    });
    expect(announced[0]!.options.map((o) => `${o.key}:${o.label}`)).toEqual(["1:Yes", "2:No"]);
    expect(requests.current?.fingerprint).toBe("hook-req-00000001");
  });

  test("Yes replies allow and settles the card as answered", async () => {
    const { requests, cleared } = harness();
    const box = track(requests.request(bash("req-00000001")));
    expect(requests.answer("1", "hook-req-00000001")).toEqual({ ok: true });
    await tick();
    expect(box.reply).toEqual({ decision: { behavior: "allow" } });
    expect(cleared).toEqual([
      { fingerprint: "hook-req-00000001", reason: "answered", answered: "1" },
    ]);
    expect(requests.size).toBe(0);
  });

  test("No denies and interrupts, like No in the terminal", async () => {
    const { requests } = harness();
    const box = track(requests.request(bash("req-00000001")));
    requests.answer("2", "hook-req-00000001");
    await tick();
    expect(box.reply).toEqual({ decision: DECLINED });
    expect(DECLINED).toMatchObject({ behavior: "deny", interrupt: true });
  });

  test("an answer without a fingerprint goes to the prompt on screen", async () => {
    const { requests } = harness();
    const box = track(requests.request(bash("req-00000001")));
    expect(requests.answer("1")).toEqual({ ok: true });
    await tick();
    expect(box.reply?.decision).toEqual({ behavior: "allow" });
  });

  test("leaves scraped prompts to the pane", () => {
    const { requests } = harness();
    expect(requests.answer("1", "a1b2c3d4")).toBeNull();
    expect(requests.answer("1")).toBeNull();
  });

  test("refuses a stale hook card and an unknown option", () => {
    const { requests } = harness();
    expect(requests.answer("1", "hook-gone-0001")?.ok).toBe(false);
    void requests.request(bash("req-00000001"));
    expect(requests.answer("3", "hook-req-00000001")).toEqual({
      ok: false,
      error: '"3" is not one of this prompt\'s options',
    });
    expect(requests.size).toBe(1);
  });

  test("a dropped hook connection (answered in the terminal) settles as dismissed", () => {
    const { requests, cleared } = harness();
    const abort = new AbortController();
    void requests.request(bash("req-00000001"), abort.signal);
    abort.abort();
    expect(cleared).toEqual([
      { fingerprint: "hook-req-00000001", reason: "dismissed", answered: undefined },
    ]);
    expect(requests.size).toBe(0);
  });

  test("a re-ask with the same id takes over the card instead of adding one", async () => {
    const { requests, cleared } = harness();
    const first = new AbortController();
    void requests.request(bash("req-00000001"), first.signal);
    const box = track(requests.request(bash("req-00000001")));
    // The first connection dying no longer settles anything.
    first.abort();
    expect(cleared).toHaveLength(0);
    expect(requests.size).toBe(1);
    requests.answer("1", "hook-req-00000001");
    await tick();
    expect(box.reply?.decision).toEqual({ behavior: "allow" });
  });

  test("auto mode is left to the dialog: the CLI ignores a hook's allow there", async () => {
    const { requests, announced } = harness();
    const reply = await requests.request(bash("req-00000001", { permissionMode: "auto" }));
    expect(reply).toEqual({ decision: null });
    expect(announced).toHaveLength(0);
  });

  describe("pane observations", () => {
    test("the first sighting copies the dialog's reason and countdown onto the card", () => {
      const { requests, announced } = harness();
      void requests.request(bash("req-00000001"));
      requests.observePane(DIALOG);
      expect(announced).toHaveLength(2);
      expect(announced[1]!.fingerprint).toBe("hook-req-00000001");
      expect(announced[1]!.context.join("\n")).toContain("This shell -c script");
      expect(announced[1]!.autoDenySec).toBe(94);
      // Later sightings change nothing.
      requests.observePane(DIALOG);
      expect(announced).toHaveLength(2);
    });

    test("a dialog gone for two polls (countdown expired) settles the card", async () => {
      const { requests, cleared } = harness();
      const box = track(requests.request(bash("req-00000001")));
      requests.observePane(DIALOG);
      requests.observePane(null);
      expect(cleared).toHaveLength(0);
      requests.observePane(null);
      await tick();
      expect(cleared).toEqual([
        { fingerprint: "hook-req-00000001", reason: "dismissed", answered: undefined },
      ]);
      expect(box.reply).toEqual({ decision: null });
    });

    test("a dialog the scraper never read doesn't count as gone", () => {
      const { requests, cleared } = harness();
      void requests.request(bash("req-00000001"));
      for (let i = 0; i < 5; i++) requests.observePane(null);
      expect(cleared).toHaveLength(0);
    });
  });

  test("settling one request re-announces the next one waiting", () => {
    const { requests, announced } = harness();
    void requests.request(bash("req-00000001"));
    void requests.request(bash("req-00000002"));
    requests.answer("1", "hook-req-00000001");
    expect(announced.at(-1)?.fingerprint).toBe("hook-req-00000002");
    expect(requests.current?.fingerprint).toBe("hook-req-00000002");
  });

  test("settleAll replies to every hook, with retry on release", async () => {
    const { requests, cleared } = harness();
    const a = track(requests.request(bash("req-00000001")));
    const b = track(requests.request(bash("req-00000002")));
    requests.settleAll("superseded", { decision: null, retry: true });
    await tick();
    expect(a.reply).toEqual({ decision: null, retry: true });
    expect(b.reply).toEqual({ decision: null, retry: true });
    expect(cleared.map((c) => c.reason)).toEqual(["superseded", "superseded"]);
    expect(requests.size).toBe(0);
  });
});

describe("describeToolInput", () => {
  test("Bash shows the description and the command", () => {
    expect(describeToolInput("Bash", { command: "ls", description: "List" })).toEqual([
      "Bash command",
      "List",
      "ls",
    ]);
  });

  test("file tools show the path", () => {
    expect(describeToolInput("Edit", { file_path: "/a/b.ts", old_string: "x" })).toEqual([
      "Edit",
      "/a/b.ts",
    ]);
  });

  test("anything else shows its input as JSON, clipped", () => {
    const lines = describeToolInput("mcp__x__y", { q: "a".repeat(5000) });
    expect(lines[0]).toBe("mcp__x__y");
    expect(lines[1]!.length).toBeLessThan(2100);
  });
});

describe("permission hook request", () => {
  const input = {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    permission_mode: "bypassPermissions",
  };

  test("parses the hook's body", () => {
    expect(
      parsePermissionHookRequest({ sessionId: "s-1", requestId: "0123456789abcdef", input }),
    ).toEqual({
      sessionId: "s-1",
      requestId: "0123456789abcdef",
      toolName: "Bash",
      toolInput: { command: "ls" },
      permissionMode: "bypassPermissions",
    });
  });

  test("rejects a body without a session, a sane request id, or a tool", () => {
    expect(parsePermissionHookRequest({ requestId: "0123456789abcdef", input })).toBeNull();
    expect(parsePermissionHookRequest({ sessionId: "s", requestId: "x/../y", input })).toBeNull();
    expect(
      parsePermissionHookRequest({ sessionId: "s", requestId: "0123456789abcdef", input: {} }),
    ).toBeNull();
    expect(parsePermissionHookRequest(null)).toBeNull();
  });

  test("a token only works for the session it was made for", () => {
    const token = permissionHookToken("secret", "session-a");
    expect(verifyPermissionHookToken("secret", "session-a", token)).toBe(true);
    expect(verifyPermissionHookToken("secret", "session-b", token)).toBe(false);
    expect(verifyPermissionHookToken("other", "session-a", token)).toBe(false);
    expect(verifyPermissionHookToken("secret", "session-a", null)).toBe(false);
    expect(verifyPermissionHookToken("secret", "session-a", "short")).toBe(false);
  });
});
