import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { headerSafe, macosScript } from "./deliveries";
import { createNotifyExtension, formatNotification } from "./index";

type Run = { argv: string[]; stdin: string };

function fakeContext(logged: string[] = []): ExtensionContext {
  const noop = () => {};
  return {
    on: () => noop,
    emit: noop,
    call: async () => ({ ok: true }),
    connectionId: null,
    tags: null,
    log: {
      info: (message: string, meta?: Record<string, unknown>) =>
        logged.push(`${message} ${JSON.stringify(meta ?? {})}`),
      warn: noop,
      error: noop,
      debug: noop,
    },
  } as unknown as ExtensionContext;
}

function recorder(runs: Run[], fail?: Error) {
  return async (argv: string[], stdin: string) => {
    runs.push({ argv, stdin });
    if (fail) throw fail;
  };
}

describe("formatNotification", () => {
  it("reads as headline, message, origin", () => {
    const text = formatNotification({ message: "Backup failed", source: "scheduler" }, "studio");
    expect(text).toBe("🔔 Anima\nBackup failed\n— scheduler on studio");
  });

  it("keeps an explicit originating host", () => {
    const text = formatNotification(
      { message: "x", title: "Token expiring", host: "laptop" },
      "studio",
    );
    expect(text).toBe("🔔 Token expiring\nx\n— on laptop");
  });
});

describe("deliveries", () => {
  it("logs by default", async () => {
    const logged: string[] = [];
    const ext = createNotifyExtension({ host: "studio" });
    await ext.start(fakeContext(logged));

    const result = await ext.handleMethod("notify.send", { message: "hello" });

    expect(result).toEqual({ sent: true, via: "log" });
    expect(logged.some((line) => line.includes("hello"))).toBe(true);
  });

  it("runs osascript for macos", async () => {
    const runs: Run[] = [];
    const ext = createNotifyExtension(
      { host: "studio", delivery: { type: "macos", sound: "Glass" } },
      { run: recorder(runs) },
    );
    await ext.start(fakeContext());

    await ext.handleMethod("notify.send", { message: 'say "hi"', source: "test" });

    expect(runs[0]?.argv.slice(0, 2)).toEqual(["osascript", "-e"]);
    expect(runs[0]?.argv[2]).toBe(
      'display notification "say \\"hi\\"" with title "Anima" subtitle "test on studio" sound name "Glass"',
    );
  });

  it("pipes the text to a command", async () => {
    const runs: Run[] = [];
    const ext = createNotifyExtension(
      { host: "studio", delivery: { type: "command", argv: ["/usr/local/bin/notify-me", "-q"] } },
      { run: recorder(runs) },
    );
    await ext.start(fakeContext());

    const result = await ext.handleMethod("notify.send", { message: "hello", source: "test" });

    expect(result).toEqual({ sent: true, via: "command:/usr/local/bin/notify-me" });
    expect(runs).toEqual([
      { argv: ["/usr/local/bin/notify-me", "-q"], stdin: "🔔 Anima\nhello\n— test on studio" },
    ]);
  });

  it("posts plain text with a Title header to a webhook", async () => {
    const posted: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, init });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const ext = createNotifyExtension(
      { host: "studio", delivery: { type: "webhook", url: "https://ntfy.example.com/anima" } },
      { fetch: fakeFetch },
    );
    await ext.start(fakeContext());

    const result = await ext.handleMethod("notify.send", { message: "hello", title: "Heads up" });

    expect(result).toEqual({ sent: true, via: "webhook:ntfy.example.com" });
    expect(posted[0]?.init.body).toBe("hello");
    expect(posted[0]?.init.headers).toMatchObject({ Title: "Heads up" });
  });

  it("encodes a non-ASCII title so the header is still valid", async () => {
    const posted: RequestInit[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      // What real fetch does first: build the headers, which throws on non-ASCII.
      new Headers(init.headers);
      posted.push(init);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const ext = createNotifyExtension(
      { delivery: { type: "webhook", url: "https://ntfy.example.com/anima" } },
      { fetch: fakeFetch },
    );
    await ext.start(fakeContext());

    await ext.handleMethod("notify.send", { message: "hello", title: "Needs your answer ✓" });

    const headers = posted[0]!.headers as Record<string, string>;
    const title = headers.Title!;
    expect(title).toBe(headerSafe("Needs your answer ✓"));
    expect(title).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const encoded = title.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Needs your answer ✓");
    expect(posted[0]?.body).toBe("hello");
  });

  it("leaves an ASCII title as it is", () => {
    expect(headerSafe("Heads up: build #12 failed")).toBe("Heads up: build #12 failed");
  });

  it("fails a webhook that doesn't answer in time instead of hanging", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const ext = createNotifyExtension(
      { delivery: { type: "webhook", url: "https://slow.example.com/hook", timeoutMs: 50 } },
      { fetch: hanging },
    );
    await ext.start(fakeContext());

    await expect(ext.handleMethod("notify.send", { message: "anyone?" })).rejects.toThrow(
      "Webhook didn't answer within 50 ms",
    );
    const health = (await ext.handleMethod("notify.health_check", {})) as {
      status: string;
    };
    expect(health.status).toBe("degraded");
  });

  it("builds an AppleScript without a sound when none is set", () => {
    expect(macosScript({ title: "T", message: "m", host: "h", text: "" })).toBe(
      'display notification "m" with title "T" subtitle "on h"',
    );
  });
});

describe("notify.send", () => {
  it("sends identical text once inside the dedupe window", async () => {
    const runs: Run[] = [];
    const ext = createNotifyExtension(
      { delivery: { type: "command", argv: ["x"] } },
      { run: recorder(runs) },
    );
    await ext.start(fakeContext());

    await ext.handleMethod("notify.send", { message: "same" });
    const second = await ext.handleMethod("notify.send", { message: "same" });
    await ext.handleMethod("notify.send", { message: "different" });

    expect(second).toEqual({ sent: false, deduped: true });
    expect(runs).toHaveLength(2);
  });

  it("lets a failed send be retried at once", async () => {
    const runs: Run[] = [];
    const ext = createNotifyExtension(
      { delivery: { type: "command", argv: ["x"] } },
      { run: recorder(runs, new Error("down")) },
    );
    await ext.start(fakeContext());

    await expect(ext.handleMethod("notify.send", { message: "retry me" })).rejects.toThrow("down");
    await expect(ext.handleMethod("notify.send", { message: "retry me" })).rejects.toThrow("down");
    expect(runs).toHaveLength(2);
  });

  it("rejects an empty message", async () => {
    const ext = createNotifyExtension({});
    await ext.start(fakeContext());
    await expect(ext.handleMethod("notify.send", { message: "" })).rejects.toThrow();
  });
});

describe("config", () => {
  it("states the configured dedupe window in the method description", () => {
    const descriptionFor = (raw: Record<string, unknown>) =>
      createNotifyExtension(raw).methods.find((m) => m.name === "notify.send")!.description;
    expect(descriptionFor({})).toContain("Identical text within 10 minutes is sent once.");
    expect(descriptionFor({ dedupeWindowMs: 30_000 })).toContain("within 30 seconds");
    expect(descriptionFor({ dedupeWindowMs: 3_600_000 })).toContain("within 1 hour");
    expect(descriptionFor({ dedupeWindowMs: 0 })).toContain("no dedupe window");
  });

  it("rejects a delivery it doesn't know", () => {
    expect(() => createNotifyExtension({ delivery: { type: "carrier-pigeon" } })).toThrow();
  });
});
