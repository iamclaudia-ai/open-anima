import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSessionOptions, ResumeSessionOptions } from "./provider-types";
import { resolveProfile, type SessionProfile } from "./profiles";
import { profileCliArgs, writeSessionMcpConfig } from "./providers/cli/profile-args";
import { SessionHost, type AgentRuntimeSession } from "./session-host";

const LOCKED: SessionProfile = {
  permissionMode: "dontAsk",
  tools: ["Read", "Grep"],
  allowedTools: ["Read", "Grep", "mcp__anima__memory_search"],
  disallowedTools: ["WebSearch"],
  mcp: "anima-only",
  restricted: true,
};

describe("resolveProfile", () => {
  it("resolves built-ins and configured profiles", () => {
    expect(resolveProfile("yolo")).toEqual({ name: "yolo", permissionMode: "bypassPermissions" });
    expect(resolveProfile("auto").permissionMode).toBe("auto");
    expect(resolveProfile("locked", { locked: LOCKED })).toEqual({ name: "locked", ...LOCKED });
  });

  it("lets config override a built-in", () => {
    expect(resolveProfile("auto", { auto: { permissionMode: "acceptEdits" } }).permissionMode).toBe(
      "acceptEdits",
    );
  });

  it("fails closed on unknown, malformed or contradictory profiles", () => {
    expect(() => resolveProfile("nope")).toThrow("Unknown session profile");
    expect(() => resolveProfile("constructor")).toThrow("Unknown session profile");
    expect(() => resolveProfile("../x")).toThrow("Invalid session profile name");
    expect(() => resolveProfile("bad", { bad: { permissionMode: "everything" as never } })).toThrow(
      "invalid permissionMode",
    );
    expect(() =>
      resolveProfile("bad", { bad: { permissionMode: "bypassPermissions", restricted: true } }),
    ).toThrow("cannot be restricted and bypass");
    expect(() =>
      resolveProfile("bad", { bad: { permissionMode: "dontAsk", mcp: "some" as never } }),
    ).toThrow("invalid mcp");
  });
});

describe("profileCliArgs", () => {
  it("keeps yolo exactly as before", () => {
    expect(profileCliArgs(resolveProfile("yolo"))).toEqual([
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "AskUserQuestion,EnterPlanMode,ExitPlanMode",
    ]);
  });

  it("locks a restricted session down", () => {
    expect(profileCliArgs(resolveProfile("locked", { locked: LOCKED }), "/x/mcp.json")).toEqual([
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep",
      "--allowedTools",
      "Read,Grep,mcp__anima__memory_search",
      "--disallowedTools",
      "AskUserQuestion,EnterPlanMode,ExitPlanMode,WebSearch",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      "/x/mcp.json",
    ]);
  });

  it("passes an empty tool list through as no built-in tools", () => {
    const args = profileCliArgs(
      resolveProfile("none", { none: { permissionMode: "dontAsk", tools: [] } }),
    );
    expect(args.slice(0, 4)).toEqual(["--permission-mode", "dontAsk", "--tools", ""]);
  });

  it("validates extra MCP servers", () => {
    const slack = { type: "http", url: "https://mcp.slack.com/mcp" };
    expect(
      resolveProfile("locked", { locked: { ...LOCKED, mcpServers: { slack } } }).mcpServers,
    ).toEqual({ slack });
    expect(() =>
      resolveProfile("x", { x: { permissionMode: "auto", mcpServers: { slack } } }),
    ).toThrow('needs mcp: "anima-only"');
    expect(() =>
      resolveProfile("locked", { locked: { ...LOCKED, mcpServers: { anima: slack } } }),
    ).toThrow("invalid MCP server name");
    expect(() =>
      resolveProfile("locked", { locked: { ...LOCKED, mcpServers: { slack: { url: "x" } } } }),
    ).toThrow("needs a type");
  });

  it("starts no MCP servers for an mcp: none profile", () => {
    const args = profileCliArgs(
      resolveProfile("scribe", {
        scribe: { permissionMode: "dontAsk", tools: ["Read", "Write"], mcp: "none" },
      }),
      "/x/ignored.json",
    );
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it("refuses mcpServers on an mcp: none profile", () => {
    expect(() =>
      resolveProfile("x", {
        x: { permissionMode: "dontAsk", mcp: "none", mcpServers: { s: { type: "http" } } },
      }),
    ).toThrow('needs mcp: "anima-only"');
  });

  it("refuses an anima-only profile without an MCP config", () => {
    expect(() => profileCliArgs(resolveProfile("locked", { locked: LOCKED }))).toThrow(
      "needs Anima's MCP",
    );
  });
});

describe("writeSessionMcpConfig", () => {
  let dir: string;
  const previous = process.env.ANIMA_DATA_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anima-mcp-"));
    process.env.ANIMA_DATA_DIR = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes an owner-only file holding only Anima's server", () => {
    const path = writeSessionMcpConfig("sess-1", {
      serverName: "anima",
      url: "http://localhost:30086/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(path).toBe(join(dir, "agent-host", "mcp", "sess-1.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcpServers: {
        anima: {
          type: "http",
          url: "http://localhost:30086/mcp",
          headers: { Authorization: "Bearer t" },
        },
      },
    });
  });

  it("adds the profile's extra servers beside Anima's, which always wins its name", () => {
    const path = writeSessionMcpConfig(
      "sess-2",
      { serverName: "anima", url: "http://localhost:30086/mcp" },
      { slack: { type: "http", url: "https://mcp.slack.com/mcp", oauth: { callbackPort: 3118 } } },
    );
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({
      slack: { type: "http", url: "https://mcp.slack.com/mcp", oauth: { callbackPort: 3118 } },
      anima: { type: "http", url: "http://localhost:30086/mcp" },
    });
  });
});

class ProfileRecordingSession extends EventEmitter {
  closed = false;
  prompts: unknown[] = [];
  constructor(
    readonly id: string,
    readonly profile: string | undefined,
  ) {
    super();
  }
  get isActive() {
    return !this.closed;
  }
  get isProcessRunning() {
    return !this.closed;
  }
  async start() {}
  prompt(content: unknown) {
    this.prompts.push(content);
  }
  interrupt() {}
  async close() {
    this.closed = true;
    this.emit("closed");
  }
  setPermissionMode() {}
  sendToolResult() {}
  getInfo() {
    const now = new Date().toISOString();
    return {
      id: this.id,
      cwd: "/tmp",
      model: "m",
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      createdAt: now,
      lastActivity: now,
      healthy: true,
      stale: false,
    };
  }
}

describe("SessionHost profiles", () => {
  function makeHost() {
    const launched: ProfileRecordingSession[] = [];
    const host = new SessionHost({
      profiles: { locked: LOCKED },
      providers: {
        claude: {
          create: (options: CreateSessionOptions) => {
            const s = new ProfileRecordingSession(
              options.sessionId ?? "new",
              options.profile?.name,
            );
            launched.push(s);
            return s as unknown as AgentRuntimeSession;
          },
          resume: (id: string, options: ResumeSessionOptions) => {
            const s = new ProfileRecordingSession(id, options.profile?.name);
            launched.push(s);
            return s as unknown as AgentRuntimeSession;
          },
        },
      },
    });
    host.setDefaults({ model: "m" });
    return { host, launched };
  }

  it("requires a known profile to create or prompt", async () => {
    const { host } = makeHost();
    await expect(host.create({ cwd: "/tmp", profile: "" })).rejects.toThrow("profile is required");
    await expect(host.create({ cwd: "/tmp", profile: "root" })).rejects.toThrow("Unknown");
    await host.create({ sessionId: "s1", cwd: "/tmp", profile: "locked" });
    await expect(host.prompt("s1", "hi", "/tmp", "m", "claude")).rejects.toThrow(
      "profile is required",
    );
  });

  it("launches with the resolved profile and persists it", async () => {
    const { host, launched } = makeHost();
    await host.create({ sessionId: "s1", cwd: "/tmp", profile: "locked" });
    expect(launched[0].profile).toBe("locked");
    expect(host.getSessionRecords()[0].profile).toBe("locked");
  });

  it("closes and relaunches a session running under the wrong profile", async () => {
    const { host, launched } = makeHost();
    // Restore/adopt can't know the profile, so it comes back as legacy yolo.
    await host.resume({ sessionId: "s1", cwd: "/tmp" });
    expect(launched[0].profile).toBe("yolo");

    await host.prompt("s1", "read the docs", "/tmp", "m", "claude", "locked");
    expect(launched[0].closed).toBe(true);
    expect(launched[1].profile).toBe("locked");
    expect(launched[1].prompts).toEqual(["read the docs"]);
    expect(host.getSessionProfile("s1")).toBe("locked");
  });

  it("leaves a session alone when the profile matches", async () => {
    const { host, launched } = makeHost();
    await host.create({ sessionId: "s1", cwd: "/tmp", profile: "locked" });
    await host.prompt("s1", "hi", "/tmp", "m", "claude", "locked");
    expect(launched).toHaveLength(1);
    expect(launched[0].prompts).toEqual(["hi"]);
  });
});
