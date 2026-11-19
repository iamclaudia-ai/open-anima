import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicTeeProxy } from "./proxy";

/**
 * Regression coverage: an agent-host restart must not cut the responses its proxies carry.
 * `drain()` frees the port at once (the next agent-host binds it) while the
 * open response streams to the end.
 */

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

/** A fake api.anthropic.com that streams `events` SSE events, one per `everyMs`. */
function fakeUpstream(events: number, everyMs: number): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch() {
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          await Bun.sleep(everyMs);
          if (i >= events) {
            c.close();
            return;
          }
          i++;
          const ev = { type: "ping", n: i };
          c.enqueue(new TextEncoder().encode(`event: ping\ndata: ${JSON.stringify(ev)}\n\n`));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanup.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

/** A port nothing is listening on (the proxy reports the port it asked for). */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("no free port");
  return port;
}

async function startProxy(upstream: string): Promise<AnthropicTeeProxy> {
  const proxy = new AnthropicTeeProxy({
    port: freePort(),
    upstream,
    allowPortProbe: false,
    onEvent: () => {},
  });
  await proxy.start();
  cleanup.push(() => proxy.stop());
  return proxy;
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe("AnthropicTeeProxy.drain", () => {
  test("an open stream finishes after drain, and the port is free at once", async () => {
    const proxy = await startProxy(fakeUpstream(5, 60));
    const port = proxy.port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5" }),
    });
    const body = readAll(res);
    await Bun.sleep(100); // mid-stream

    const drain = proxy.drain();
    expect(drain.inFlight).toBe(1);

    // The next agent-host can bind the same port while this stream runs.
    const next = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("next") });
    cleanup.push(() => next.stop(true));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("next");

    let settled = false;
    void drain.done.then(() => (settled = true));
    expect(settled).toBe(false);

    const text = await body;
    expect(text.match(/data: /g)?.length).toBe(5); // every event arrived, nothing cut
    await drain.done;
    expect(settled).toBe(true);
  });

  test("an idle proxy drains with nothing in flight", async () => {
    const proxy = await startProxy(fakeUpstream(1, 10));
    const drain = proxy.drain();
    expect(drain.inFlight).toBe(0);
    await drain.done;
  });

  test("a request that still reaches a draining proxy gets a retryable 503", async () => {
    const proxy = await startProxy(fakeUpstream(1, 10));
    proxy.drain();
    // Only reachable on a connection that was busy when the listener closed,
    // so call the handler directly.
    const handle = proxy["handle"].bind(proxy);
    const res = await handle(new Request("http://127.0.0.1/v1/messages", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("connection")).toBe("close");
    const json = (await res.json()) as { type: string; error: { type: string } };
    expect(json.type).toBe("error");
  });
});
