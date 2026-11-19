/**
 * Anima Configuration Loader
 *
 * Features:
 * - JSON5 format (supports comments, trailing commas)
 * - Environment variable interpolation: "${ENV_VAR}"
 * - Type-safe config
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { generateToken } from "./auth";
import {
  animaConfigHome,
  DEFAULT_AGENT_HOST_PORT,
  DEFAULT_GATEWAY_PORT,
  envPort,
  normalizeTmuxPrefix,
} from "./instance";
import type { WebStaticPath } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface GatewayConfig {
  port: number;
  /**
   * Bind address. Use a literal IP, not "localhost": Bun binds only the first
   * address a name resolves to, and macOS 27 resolves localhost to ::1 first,
   * which leaves the gateway unreachable to IPv4 proxies like Caddy.
   */
  host: string;
  /** Public endpoint hostname for remote clients (e.g., "anima.example.com") */
  endpoint?: string;
  /** Heartbeat interval in milliseconds for broadcasting to extensions (default: 300000 = 5min) */
  heartbeatIntervalMs?: number;
  /** Bearer token for gateway authentication. Auto-generated on first run if missing. */
  token?: string;
}

export type ThinkingEffort = "low" | "medium" | "high" | "max";

export interface ImageProcessingConfig {
  /** Enable automatic image resizing/compression before sending to API */
  enabled: boolean;
  /** Target max width in pixels (default: 1600) */
  maxWidth: number;
  /** Target max height in pixels (default: 1600) */
  maxHeight: number;
  /** Target max file size in bytes (default: 1MB) */
  maxFileSizeBytes: number;
  /** Output format: 'webp' | 'jpeg' | 'png' (default: 'webp') */
  format: "webp" | "jpeg" | "png";
  /** Output quality 1-100 (default: 85) */
  quality: number;
}

export interface SessionConfig {
  model: string;
  thinking: boolean;
  effort: ThinkingEffort;
  systemPrompt: string | null;
  /** Additional skill paths (additive to default probe paths) */
  skills: {
    paths: string[];
  };
  /** Image processing settings */
  imageProcessing: ImageProcessingConfig;
}

export interface ExtensionConfig {
  enabled: boolean;
  /** Source prefixes this extension handles for routing (e.g., ["chatbridge"]) */
  sourceRoutes?: string[];
  /** Enable Bun --hot for live reloading (default: false). Set true explicitly
   *  for rapid iteration when developing an extension. */
  hot?: boolean;
  /**
   * Optional static URL path overrides. Merged with the extension's code-level
   * `webStatic` declarations by `path`: a config entry replaces a code entry
   * with the same `path`; new entries get appended. Useful for relocating
   * homedir-based paths (e.g., point /myext/static at a different folder).
   */
  webStatic?: WebStaticPath[];
  config: Record<string, unknown>;
  /**
   * Public, client-safe configuration exposed to the SPA. Returned alongside
   * the extension's web bundle URL via `gateway.list_web_contributions` /
   * `/api/web-contributions`, and read on the client through
   * `useExtensionConfig(id)` from `@anima/ui`.
   *
   * Keep this strictly to non-secret values (URLs, feature flags, defaults).
   * Server-only secrets — API keys, tokens, paths — belong in `config`.
   */
  webConfig?: Record<string, unknown>;
}

export type ExtensionsConfig = Record<string, ExtensionConfig>;

export interface AgentHostConfig {
  /**
   * Agent-host WebSocket URL the session extension connects to. Derived from
   * `port` (`ws://localhost:<port>/ws`) unless set explicitly.
   */
  url: string;
  /** Port agent-host listens on (env `ANIMA_AGENT_HOST_PORT` overrides). Default 30087. */
  port: number;
  /**
   * Namespace for this instance's tmux panes: `<prefix>-claude-<id>` and
   * `<prefix>-wrapper-<id>`. agent-host only adopts and reaps panes with its
   * own prefix, so a second instance on the same machine needs its own (env
   * `ANIMA_TMUX_PREFIX` overrides). Default "anima".
   */
  tmuxPrefix?: string;
  /** Automatic MCP tools exposed by gateway-loaded extensions */
  extensionMcp?: {
    enabled?: boolean;
    serverName?: string;
    url?: string;
    alwaysLoad?: boolean;
  };
  /**
   * Session permission profiles, merged over the built-ins (`yolo`, `auto`).
   * See packages/agent-host/src/profiles.ts.
   */
  sessionProfiles?: Record<
    string,
    {
      permissionMode: "bypassPermissions" | "auto" | "dontAsk" | "acceptEdits" | "plan" | "default";
      tools?: string[];
      allowedTools?: string[];
      disallowedTools?: string[];
      mcp?: "default" | "anima-only" | "none";
      mcpServers?: Record<string, Record<string, unknown>>;
      restricted?: boolean;
    }
  >;
  /** Codex provider configuration */
  codex?: {
    apiKey?: string;
    cliPath?: string;
    model?: string;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    autoApprove?: boolean;
    personality?: string;
    cwd?: string;
    preambles?: { subagent?: string; review?: string; test?: string };
  };
  /** Claude runtime: "sdk" (Agent SDK) or "cli" (real CLI + tee proxy). Default "sdk". */
  claudeRuntime?: "sdk" | "cli";
  /** Claude CLI runtime configuration (used when claudeRuntime === "cli"). */
  claudeCli?: {
    cliPath?: string;
    basePort?: number;
    interception?: "base-url" | "mitm";
    /** Append full request/response JSON to ~/.anima/logs/cli-proxy-capture.jsonl. */
    capture?: boolean;
  };
  /**
   * Persona every Claude session starts with: a name looked up in
   * `~/.anima/personas/<name>.md`, then the repo's `personas/`; a path to a
   * markdown file; or "none". Default "lumen". See docs/PERSONAS.md.
   */
  persona?: string;
  /**
   * CLI runtime only: "append" (default) keeps Claude Code's own system
   * prompt and adds the persona after it; "replace" swaps it out entirely.
   * The SDK runtime always puts the persona first in a prompt of its own,
   * which behaves like "replace".
   */
  personaMode?: "append" | "replace";
  /** Idle-reaper: close sessions whose last activity is older than this (ms). */
  idleStaleMs?: number;
  /** How often the idle reaper runs (ms). */
  reapIntervalMs?: number;
  /**
   * Also reap orphan `anima-wrapper-*` tmux panes created by the tmux-wrap
   * PreToolUse hook. Kept only when attached or idle below `idleStaleMs`.
   */
  reapTmuxOrphans?: boolean;
}

export interface FederationPeer {
  id: string;
  url: string;
  role: "primary" | "replica";
}

export interface FederationConfig {
  enabled: boolean;
  nodeId: string;
  peers: FederationPeer[];
}

export interface AnimaConfig {
  gateway: GatewayConfig;
  session: SessionConfig;
  extensions: ExtensionsConfig;
  agentHost: AgentHostConfig;
  federation: FederationConfig;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: AnimaConfig = {
  gateway: {
    port: DEFAULT_GATEWAY_PORT,
    host: "127.0.0.1",
    heartbeatIntervalMs: 300000, // 5 minutes
  },
  session: {
    model: "claude-opus-4-6",
    thinking: false,
    effort: "medium",
    systemPrompt: null,
    skills: {
      paths: [],
    },
    imageProcessing: {
      enabled: true,
      maxWidth: 1600,
      maxHeight: 1600,
      maxFileSizeBytes: 1024 * 1024, // 1MB
      format: "webp",
      quality: 85,
    },
  },
  extensions: {},
  agentHost: {
    url: `ws://localhost:${DEFAULT_AGENT_HOST_PORT}/ws`,
    port: DEFAULT_AGENT_HOST_PORT,
    idleStaleMs: 7_200_000, // 2 hours
    reapIntervalMs: 60_000, // 1 minute
    reapTmuxOrphans: true,
  },
  federation: {
    enabled: false,
    nodeId: "default",
    peers: [],
  },
};

// ============================================================================
// Environment Variable Interpolation
// ============================================================================

/**
 * Replace ${ENV_VAR} patterns with process.env values
 * Supports nested objects and arrays
 */
function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Match ${VAR_NAME} pattern
    return obj.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
      const value = process.env[envVar];
      if (value === undefined) {
        console.warn(`[Config] Warning: Environment variable ${envVar} is not set`);
        return "";
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
}

// ============================================================================
// Config Loader
// ============================================================================

let cachedConfig: AnimaConfig | null = null;

/**
 * Load configuration from anima.json
 *
 * Search order:
 * 1. explicit configPath argument
 * 2. ANIMA_CONFIG env var
 * 3. $ANIMA_HOME/.anima/anima.json (default ~/.anima/anima.json)
 *
 * Env overrides applied after the file: `ANIMA_GATEWAY_PORT`,
 * `ANIMA_AGENT_HOST_PORT`, `ANIMA_TMUX_PREFIX`. See `instance.ts`.
 */
export function loadConfig(configPath?: string): AnimaConfig {
  if (cachedConfig && !configPath) {
    return cachedConfig;
  }

  // Determine config file path
  // Search order: explicit path → env var → $ANIMA_HOME/.anima/anima.json
  const configHome = animaConfigHome();
  const paths = [
    configPath,
    process.env.ANIMA_CONFIG,
    join(configHome, ".anima", "anima.json"),
  ].filter(Boolean) as string[];

  let rawConfig: Partial<AnimaConfig> | null = null;
  let loadedFrom: string | null = null;

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        rawConfig = JSON5.parse(content);
        loadedFrom = path;
        break;
      } catch (error) {
        throw new Error(`[Config] Error parsing ${path}: ${String(error)}`);
      }
    }
  }

  if (!loadedFrom || !rawConfig) {
    const searched = paths.length > 0 ? paths.join(", ") : "(none)";
    throw new Error(
      `[Config] No config file found. Searched: ${searched}. Copy anima.example.json to ~/.anima/anima.json`,
    );
  }

  // Interpolate environment variables
  const interpolated = interpolateEnvVars(rawConfig) as Partial<AnimaConfig>;

  // Merge with defaults
  const config: AnimaConfig = {
    gateway: { ...DEFAULT_CONFIG.gateway, ...interpolated.gateway },
    session: { ...DEFAULT_CONFIG.session, ...interpolated.session },
    extensions: interpolated.extensions ?? DEFAULT_CONFIG.extensions,
    agentHost: { ...DEFAULT_CONFIG.agentHost, ...interpolated.agentHost },
    federation: { ...DEFAULT_CONFIG.federation, ...interpolated.federation },
  };

  applyInstanceOverrides(config, interpolated.agentHost?.url);

  cachedConfig = config;
  return config;
}

/**
 * Env overrides for the values that must differ between two instances on one
 * machine, and the agent-host URL derived from its port when the file doesn't
 * set one, so changing `agentHost.port` alone moves both ends.
 */
function applyInstanceOverrides(
  config: AnimaConfig,
  explicitAgentHostUrl: string | undefined,
): void {
  const gatewayPort = envPort("ANIMA_GATEWAY_PORT");
  if (gatewayPort) config.gateway.port = gatewayPort;
  const agentHostPort = envPort("ANIMA_AGENT_HOST_PORT");
  if (agentHostPort) config.agentHost.port = agentHostPort;
  if (!explicitAgentHostUrl) {
    config.agentHost.url = `ws://localhost:${config.agentHost.port}/ws`;
  } else if (agentHostPort) {
    const url = new URL(explicitAgentHostUrl);
    url.port = String(agentHostPort);
    config.agentHost.url = url.toString();
  }
  config.agentHost.tmuxPrefix = normalizeTmuxPrefix(
    process.env.ANIMA_TMUX_PREFIX || config.agentHost.tmuxPrefix,
  );
}

/**
 * Get extension config by ID
 */
export function getExtensionConfig(id: string): ExtensionConfig | undefined {
  const config = loadConfig();
  return config.extensions[id];
}

/**
 * Check if extension is enabled
 */
export function isExtensionEnabled(id: string): boolean {
  const ext = getExtensionConfig(id);
  return ext?.enabled ?? false;
}

/**
 * Get the public, client-safe `webConfig` slice for an extension. Returns
 * an empty object when the extension declares no `webConfig` so callers can
 * destructure without null checks.
 */
export function getExtensionWebConfig(id: string): Record<string, unknown> {
  return getExtensionConfig(id)?.webConfig ?? {};
}

/**
 * Get all enabled extensions as [id, config] pairs
 */
export function getEnabledExtensions(): [string, ExtensionConfig][] {
  const config = loadConfig();
  return Object.entries(config.extensions).filter(([_, ext]) => ext.enabled);
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

// ============================================================================
// Token Management
// ============================================================================

/**
 * Resolve the config file path (same search order as loadConfig).
 */
export function resolveConfigPath(configPath?: string): string {
  const configHome = animaConfigHome();
  const paths = [
    configPath,
    process.env.ANIMA_CONFIG,
    join(configHome, ".anima", "anima.json"),
  ].filter(Boolean) as string[];

  for (const path of paths) {
    if (existsSync(path)) return path;
  }

  return join(configHome, ".anima", "anima.json");
}

/**
 * Write a token into the config file's gateway section.
 * Uses targeted insertion to preserve JSON5 comments and formatting.
 */
export function writeConfigToken(token: string, configPath?: string): void {
  const path = resolveConfigPath(configPath);
  const content = readFileSync(path, "utf-8");

  // If token already exists in the gateway block, replace it
  const tokenPattern = /("token"\s*:\s*)"[^"]*"/;
  if (tokenPattern.test(content)) {
    const updated = content.replace(tokenPattern, `$1"${token}"`);
    writeFileSync(path, updated, "utf-8");
  } else {
    // Insert after the opening brace of the "gateway" block
    const gatewayPattern = /("gateway"\s*:\s*\{)/;
    const match = content.match(gatewayPattern);
    if (match && match.index !== undefined) {
      const insertPos = match.index + match[0].length;
      const updated =
        content.slice(0, insertPos) + `\n    "token": "${token}",` + content.slice(insertPos);
      writeFileSync(path, updated, "utf-8");
    } else {
      throw new Error(
        `Could not find "gateway" section in ${path}. Add it manually: "gateway": { "token": "${token}" }`,
      );
    }
  }

  // Clear cache so next loadConfig picks up the new token
  clearConfigCache();
}

/**
 * Ensure a gateway token exists. If missing, generates one and writes it to config.
 * Returns the token (existing or newly generated).
 */
export function ensureToken(configPath?: string): { token: string; generated: boolean } {
  const config = loadConfig(configPath);
  if (config.gateway.token) {
    return { token: config.gateway.token, generated: false };
  }

  // The gateway and agent-host both call this on a first boot, often at the
  // same moment. Re-read the file just before writing, so a token the other
  // process wrote in between is kept rather than overwritten.
  clearConfigCache();
  const onDisk = loadConfig(configPath).gateway.token;
  if (onDisk) return { token: onDisk, generated: false };

  const token = generateToken();
  writeConfigToken(token, configPath);
  return { token, generated: true };
}
