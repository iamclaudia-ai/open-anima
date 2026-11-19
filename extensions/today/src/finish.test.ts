import { expect, test } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { createTodayExtension } from "./index";
import { setSession } from "./store";
import { todayTestDb } from "./test-db";

const NOW = "2026-11-13T18:00:00.000Z";

/** A board with no sources, whose `ctx.call`s the test reads. */
async function board() {
  const db = todayTestDb();
  const calls: Array<[string, unknown]> = [];
  const extension = createTodayExtension(
    { projects: [{ name: "personal", cwd: "/repo/personal" }] },
    { openDb: () => db, now: () => new Date(NOW), run: async () => "[]" },
  );
  const ctx = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
    on: () => () => {},
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return {};
    },
  } as unknown as ExtensionContext;
  await extension.start(ctx);
  const add = async (title: string, sessionId: string) => {
    const item = (await extension.handleMethod("today.add_item", {
      project: "personal",
      title,
    })) as { id: number };
    setSession(db, item.id, { sessionId, workspaceId: "ws" }, NOW, true);
    return item.id;
  };
  const resolved = () =>
    calls
      .filter(([method]) => method === "session.set_status")
      .map(([, params]) => (params as { sessionId: string }).sessionId);
  return { extension, add, resolved };
}

test("closing the last item a session works marks the session done", async () => {
  const b = await board();
  const first = await b.add("First half", "s1");
  const second = await b.add("Second half", "s1");

  await b.extension.handleMethod("today.complete", { id: first, by: "user" });
  expect(b.resolved()).toEqual([]);

  await b.extension.handleMethod("today.dismiss", { id: second, by: "agent" });
  expect(b.resolved()).toEqual(["s1"]);

  // Reopening it says nothing to the session: your next prompt is what reopens it.
  await b.extension.handleMethod("today.reopen", { id: second, by: "user" });
  expect(b.resolved()).toEqual(["s1"]);
  await b.extension.stop();
});
