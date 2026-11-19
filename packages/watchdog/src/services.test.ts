import { afterEach, describe, expect, it } from "bun:test";
import { checkHealth, ownedByService, withOwnAnimaEnv, type ManagedService } from "./services";

function makeService(overrides: Partial<ManagedService> = {}): ManagedService {
  return {
    name: "Gateway",
    id: "gateway",
    command: ["bun", "run", "packages/gateway/src/start.ts"],
    cwd: "/tmp/test",
    healthUrl: "http://localhost:30086/health",
    port: 30086,
    requireExtensions: true,
    drainMs: 0,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
    lastHealthDetails: null,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("watchdog health checks", () => {
  it("marks gateway unhealthy when health endpoint reports zero extensions", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ok", extensions: {} }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe("zero_extensions");
  });

  it("marks gateway healthy when at least one extension is loaded", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          extensions: { session: { ok: true } },
        }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(true);
  });

  it("treats non-gateway service as healthy on HTTP 200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    const result = await checkHealth(
      makeService({
        id: "agent-host",
        name: "Agent Host",
        healthUrl: "http://localhost:30087/health",
        requireExtensions: false,
      }),
    );
    expect(result.healthy).toBe(true);
  });
});

describe("ownedByService", () => {
  it("claims only processes started in the service's folder", () => {
    expect(ownedByService("/srv/open-anima", "/srv/open-anima")).toBe(true);
    expect(ownedByService("/srv/open-anima/packages/gateway", "/srv/open-anima/")).toBe(true);
    // Another instance on the same machine, or a folder that merely shares a prefix.
    expect(ownedByService("/srv/anima", "/srv/open-anima")).toBe(false);
    expect(ownedByService("/srv/open-anima2", "/srv/open-anima")).toBe(false);
    expect(ownedByService(null, "/srv/open-anima")).toBe(false);
  });
});

describe("withOwnAnimaEnv", () => {
  it("keeps the watchdog's own ANIMA_* values over the login shell's", () => {
    const { env, overridden } = withOwnAnimaEnv(
      {
        PATH: "/login/bin",
        ANIMA_DATA_DIR: "/Users/x/.anima",
        ANIMA_GATEWAY_PORT: "30086",
        ANIMA_MEMORY_DIR: "/Users/x/memory",
      },
      {
        PATH: "/launchd/bin",
        ANIMA_DATA_DIR: "/srv/second/data",
        ANIMA_GATEWAY_PORT: "31086",
        ANIMA_TMUX_PREFIX: "second",
        ANIMA_HOME: undefined,
      },
    );
    expect(env).toEqual({
      // Everything else still comes from the login shell.
      PATH: "/login/bin",
      ANIMA_DATA_DIR: "/srv/second/data",
      ANIMA_GATEWAY_PORT: "31086",
      ANIMA_TMUX_PREFIX: "second",
      // Not set for the watchdog: the login shell's value stays.
      ANIMA_MEMORY_DIR: "/Users/x/memory",
    });
    expect(overridden).toEqual(["ANIMA_DATA_DIR", "ANIMA_GATEWAY_PORT"]);
  });
});
