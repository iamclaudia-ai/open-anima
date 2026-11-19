import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearConfigCache,
  ensureToken,
  getEnabledExtensions,
  getExtensionConfig,
  isExtensionEnabled,
  loadConfig,
} from "./config";

describe("config loader", () => {
  let tempDir = "";
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-config-test-"));
    envBackup = { ...process.env };
    clearConfigCache();
  });

  afterEach(() => {
    process.env = envBackup;
    clearConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads JSON5 config file and interpolates env vars", () => {
    const configPath = join(tempDir, "anima.json");
    process.env.TEST_ENDPOINT = "gateway.example.com";
    process.env.TEST_MODEL = "claude-opus";

    writeFileSync(
      configPath,
      `{
        gateway: {
          port: 40001,
          endpoint: "\${TEST_ENDPOINT}",
        },
        session: {
          model: "\${TEST_MODEL}",
          thinking: true,
          effort: "high",
        },
        extensions: {
          hooks: { enabled: true, config: { dir: "/hooks" } },
        },
      }`,
      "utf-8",
    );

    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(40001);
    expect(config.gateway.endpoint).toBe("gateway.example.com");
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.session.model).toBe("claude-opus");
    expect(config.session.thinking).toBe(true);
    expect(config.session.effort).toBe("high");
    expect(config.extensions.hooks?.enabled).toBe(true);
  });

  it("throws when no config file exists", () => {
    const missingPath = join(tempDir, "missing.json");
    process.env.ANIMA_HOME = tempDir;
    delete process.env.ANIMA_CONFIG;
    expect(() => loadConfig(missingPath)).toThrow("No config file found");
  });

  it("handles missing interpolated env vars and parse errors gracefully", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    const badPath = join(tempDir, "bad.json");
    writeFileSync(badPath, "{ invalid json", "utf-8");

    expect(() => loadConfig(badPath)).toThrow("Error parsing");

    // Missing env interpolation warning path
    clearConfigCache();
    const goodPath = join(tempDir, "good.json");
    writeFileSync(
      goodPath,
      `{
        gateway: { endpoint: "\${UNSET_ENV}" },
      }`,
      "utf-8",
    );
    const interpolated = loadConfig(goodPath);
    expect(interpolated.gateway.endpoint).toBe("");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("caches loadConfig and supports extension helper APIs", () => {
    const configPath = join(tempDir, "anima.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extensions: {
          a: { enabled: true, config: { x: 1 } },
          b: { enabled: false, config: { y: 2 } },
        },
      }),
      "utf-8",
    );

    const first = loadConfig(configPath);
    const second = loadConfig();
    expect(second).toBe(first); // cached when no explicit path provided

    expect(getExtensionConfig("a")).toEqual({ enabled: true, config: { x: 1 } });
    expect(getExtensionConfig("missing")).toBeUndefined();
    expect(isExtensionEnabled("a")).toBe(true);
    expect(isExtensionEnabled("b")).toBe(false);
    expect(getEnabledExtensions()).toEqual([["a", { enabled: true, config: { x: 1 } }]]);
  });

  it("loads additive session skill paths from config", () => {
    const configPath = join(tempDir, "anima.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        session: {
          skills: {
            paths: ["~/.anima/skills", ".anima/skills", "/tmp/custom-skills"],
          },
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.session.skills.paths).toEqual([
      "~/.anima/skills",
      ".anima/skills",
      "/tmp/custom-skills",
    ]);
  });

  describe("instance settings", () => {
    beforeEach(() => {
      delete process.env.ANIMA_GATEWAY_PORT;
      delete process.env.ANIMA_AGENT_HOST_PORT;
      delete process.env.ANIMA_TMUX_PREFIX;
    });

    function write(config: unknown): string {
      const configPath = join(tempDir, "anima.json");
      writeFileSync(configPath, JSON.stringify(config));
      return configPath;
    }

    it("defaults the ports, agent-host url and tmux prefix", () => {
      const config = loadConfig(write({}));
      expect(config.gateway.port).toBe(30086);
      expect(config.agentHost.port).toBe(30087);
      expect(config.agentHost.url).toBe("ws://localhost:30087/ws");
      expect(config.agentHost.tmuxPrefix).toBe("anima");
    });

    it("derives the agent-host url from agentHost.port", () => {
      const config = loadConfig(write({ agentHost: { port: 31087 } }));
      expect(config.agentHost.url).toBe("ws://localhost:31087/ws");
    });

    it("keeps an explicit agent-host url", () => {
      const config = loadConfig(
        write({ agentHost: { port: 31087, url: "ws://10.0.0.5:31087/ws" } }),
      );
      expect(config.agentHost.url).toBe("ws://10.0.0.5:31087/ws");
    });

    it("lets env override the ports and prefix", () => {
      process.env.ANIMA_GATEWAY_PORT = "32086";
      process.env.ANIMA_AGENT_HOST_PORT = "32087";
      process.env.ANIMA_TMUX_PREFIX = "open-anima";
      const config = loadConfig(
        write({ gateway: { port: 31086 }, agentHost: { url: "ws://10.0.0.5:31087/ws" } }),
      );
      expect(config.gateway.port).toBe(32086);
      expect(config.agentHost.port).toBe(32087);
      expect(config.agentHost.url).toBe("ws://10.0.0.5:32087/ws");
      expect(config.agentHost.tmuxPrefix).toBe("open-anima");
    });

    it("rejects a tmux prefix that could collide with another instance's panes", () => {
      expect(() => loadConfig(write({ agentHost: { tmuxPrefix: "anima-" } }))).toThrow(
        "Invalid tmux prefix",
      );
    });
  });
});

describe("ensureToken", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-token-test-"));
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(gateway: string): string {
    const configPath = join(tempDir, "anima.json");
    writeFileSync(configPath, `{\n  // comment kept\n  "gateway": {${gateway}}\n}\n`, "utf-8");
    return configPath;
  }

  it("generates a token on first boot and writes it into the gateway block", () => {
    const configPath = writeConfig(` "port": 40002 `);
    const first = ensureToken(configPath);
    expect(first.generated).toBe(true);
    expect(first.token).toMatch(/^anima_sk_/);
    const text = readFileSync(configPath, "utf-8");
    expect(text).toContain(`"token": "${first.token}"`);
    expect(text).toContain("// comment kept");

    clearConfigCache();
    expect(ensureToken(configPath)).toEqual({ token: first.token, generated: false });
  });

  it("keeps a token another process wrote after this one loaded the config", () => {
    const configPath = writeConfig(` "port": 40003 `);
    expect(loadConfig(configPath).gateway.token).toBeFalsy(); // cached without a token
    writeConfig(` "token": "anima_sk_from_gateway", "port": 40003 `);
    expect(ensureToken(configPath)).toEqual({ token: "anima_sk_from_gateway", generated: false });
    expect(readFileSync(configPath, "utf-8")).toContain("anima_sk_from_gateway");
  });
});
