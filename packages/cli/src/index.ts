#!/usr/bin/env bun
/**
 * Anima CLI - Gateway client
 *
 * Usage:
 *   anima workspace list
 *   anima session send_prompt --sessionId ses_123 --content "Hello"
 *   anima methods
 */

import {
  animaConfigHome,
  animaDataDir,
  createGatewayClient,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_WATCHDOG_PORT,
  envPort,
  generateToken,
  loadConfig,
  resolveConfigPath,
  writeConfigToken,
} from "@anima/shared";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionCli } from "@anima/shared";
import {
  formatLocalCommands,
  listExtensionCliNamespaces,
  loadExtensionCli,
} from "./extension-cli.js";

/**
 * The gateway this CLI talks to by default: `ANIMA_GATEWAY_URL`, else the
 * local gateway on the configured port (`gateway.port` in anima.json, env
 * `ANIMA_GATEWAY_PORT`), else 30086. `--gateway-url` / `--host` override it.
 */
function defaultGatewayUrl(): string {
  const fromEnv = envPort("ANIMA_GATEWAY_PORT");
  if (fromEnv) return `ws://localhost:${fromEnv}/ws`;
  try {
    return `ws://localhost:${loadConfig().gateway.port}/ws`;
  } catch {
    return `ws://localhost:${DEFAULT_GATEWAY_PORT}/ws`;
  }
}

const DEFAULT_GATEWAY_URL = defaultGatewayUrl();
let gatewayUrl = process.env.ANIMA_GATEWAY_URL || DEFAULT_GATEWAY_URL;

function normalizeGatewayUrl(value: string): string {
  const input = value.trim();
  if (!input) return DEFAULT_GATEWAY_URL;

  if (input.startsWith("ws://") || input.startsWith("wss://")) {
    return input;
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const parsed = new URL(input);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/ws";
    return parsed.toString();
  }

  return `ws://${input.replace(/\/+$/, "")}/ws`;
}

function extractGlobalConnectionArgs(rawArgs: string[]): {
  args: string[];
  resolvedGatewayUrl: string;
} {
  const args: string[] = [];
  let hostOverride: string | undefined;
  let urlOverride: string | undefined;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i] ?? "";

    if (token === "--host") {
      const next = rawArgs[i + 1];
      if (!next) throw new Error("Missing value for --host");
      hostOverride = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--host=")) {
      hostOverride = token.slice("--host=".length);
      continue;
    }

    if (token === "--gateway-url") {
      const next = rawArgs[i + 1];
      if (!next) throw new Error("Missing value for --gateway-url");
      urlOverride = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--gateway-url=")) {
      urlOverride = token.slice("--gateway-url=".length);
      continue;
    }

    args.push(token);
  }

  const resolvedGatewayUrl = normalizeGatewayUrl(urlOverride || hostOverride || gatewayUrl);
  return { args, resolvedGatewayUrl };
}

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema | JsonSchema[];
}

export interface MethodCatalogEntry {
  method: string;
  source: "gateway" | "extension";
  extensionId?: string;
  extensionName?: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface InjectSessionIdResult {
  didInject: boolean;
  error?: string;
}

export function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }

  // Template variables like {{date}} start with {{ — don't try to parse as JSON
  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("{") && value.endsWith("}") && !value.startsWith("{{"))
  ) {
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(
        `Failed to parse JSON parameter: ${value}\n${String(e)}\nHint: Wrap JSON in single quotes — --param '{"key":"value"}'`,
      );
    }
  }

  return value;
}

/**
 * Set a value at a dot-separated path in a nested object.
 * e.g. setNestedValue(obj, "action.type", "notification")
 *   → obj.action = { type: "notification" }
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current[part] === undefined ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Strip a flag name down to its letters and digits, lowercased.
 *
 * `--session-id`, `--session_id`, `--SessionId` and `--sessionid` all reduce to
 * `sessionid`, which is what lets any of them find the schema's `sessionId`.
 */
function normalizeKeyToken(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * The declared properties of an object schema, looking through $ref and into
 * anyOf/allOf branches (an optional nested object arrives as `anyOf: [obj, null]`).
 */
function objectProperties(
  schema: JsonSchema | undefined,
  root: JsonSchema,
): Record<string, JsonSchema> | undefined {
  const resolved = resolveSchema(schema, root);
  if (!resolved) return undefined;
  if (resolved.properties) return resolved.properties;
  for (const branch of [...(resolved.anyOf ?? []), ...(resolved.allOf ?? [])]) {
    const props = objectProperties(branch, root);
    if (props) return props;
  }
  return undefined;
}

/**
 * Rewrite a typed flag into the spelling the schema uses.
 *
 * The CLI mirrors Zod schemas, which are camelCase, but `--session-id` is the
 * more natural thing to type — so every casing convention is accepted and
 * mapped back: hyphens, underscores, and case are all ignored when matching.
 * Each segment of a dot path is resolved against its own level of the schema.
 *
 * An unmatched segment is left verbatim so the existing "Unknown params" error
 * still names what the user actually typed, and free-form objects (no declared
 * properties) pass through untouched — their keys are data, not API surface.
 */
export function canonicalizeKeyPath(key: string, schema?: JsonSchema): string {
  if (!schema) return key;
  let level = objectProperties(schema, schema);
  const out: string[] = [];

  for (const segment of key.split(".")) {
    let name = segment;
    if (level && !(segment in level)) {
      const target = normalizeKeyToken(segment);
      const matches = Object.keys(level).filter((p) => normalizeKeyToken(p) === target);
      // Ambiguity is only possible if a schema declares two properties that
      // differ by punctuation alone; leave those to the validator.
      if (matches.length === 1) name = matches[0];
    }
    out.push(name);
    level = level?.[name] ? objectProperties(level[name], schema) : undefined;
  }

  return out.join(".");
}

/**
 * True when the method declares this param as a plain string.
 *
 * Used to keep {@link coerceValue} from guessing: `--key 1` on a string param
 * should stay `"1"`. Only top-level keys — a dot-notation path addresses a
 * free-form object, which has no declared leaf type to consult.
 */
function declaresString(key: string, schema?: JsonSchema): boolean {
  if (!schema || key.includes(".")) return false;
  const resolved = resolveSchema(schema, schema) ?? schema;
  const prop = resolved.properties?.[key];
  if (!prop) return false;
  return schemaType(prop, schema) === "string";
}

/**
 * Parse `--flag value` pairs into a params object.
 *
 * `schema` is optional but worth passing: without it the parser has to guess a
 * type from the text, and anything that looks like a number becomes one. That
 * is right for `--limit 50` and wrong for every string param whose value
 * happens to be digits — an option key, a version, a title of "2026" — which
 * then fails validation as "expected string, got number".
 */
export function parseCliParams(rawArgs: string[], schema?: JsonSchema): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}. Use --name value.`);
    }

    const flag = token.slice(2);
    if (!flag) throw new Error("Invalid flag: --");

    let key: string;
    let raw: string | undefined;

    const eqIdx = flag.indexOf("=");
    if (eqIdx >= 0) {
      key = flag.slice(0, eqIdx);
      raw = flag.slice(eqIdx + 1);
    } else {
      key = flag;
      const next = rawArgs[i + 1];
      if (!next || next.startsWith("--")) {
        setNestedValue(params, canonicalizeKeyPath(key, schema), true);
        continue;
      }
      raw = next;
      i += 1;
    }

    // `--session-id`, `--session_id` and `--sessionId` all mean the same param.
    key = canonicalizeKeyPath(key, schema);

    // The raw text stands when the method says it wants a string — no lossy
    // round-trip through Number ("1.50" would come back as "1.5").
    const value = declaresString(key, schema) ? raw : coerceValue(raw);

    // Support dot notation: --action.type notification → { action: { type: "notification" } }
    if (key.includes(".")) {
      setNestedValue(params, key, value);
    } else {
      params[key] = value;
    }
  }

  return params;
}

export function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (
      !current ||
      typeof current !== "object" ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonSchema;
}

export function resolveSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema | undefined,
  depth = 0,
): JsonSchema | undefined {
  if (!schema) return undefined;
  if (!root) return schema;
  if (!schema.$ref || depth > 20) return schema;

  const referenced = resolveRef(root, schema.$ref);
  if (!referenced) return schema;

  const resolvedRef = resolveSchema(referenced, root, depth + 1) ?? referenced;
  const { $ref: _unusedRef, ...inlineOverrides } = schema;
  return { ...resolvedRef, ...inlineOverrides };
}

export function schemaType(schema?: JsonSchema, root?: JsonSchema): string {
  const resolved = resolveSchema(schema, root ?? schema) ?? schema;
  if (!resolved) return "unknown";
  if (resolved.type) return resolved.type;
  if (resolved.anyOf?.length) {
    return resolved.anyOf.map((s) => schemaType(s, root ?? resolved)).join("|");
  }
  if (resolved.allOf?.length) {
    return resolved.allOf.map((s) => schemaType(s, root ?? resolved)).join("&");
  }
  return "unknown";
}

export function matchesSchemaType(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const resolved = resolveSchema(schema, root) ?? schema;
  if (resolved.anyOf?.length) return resolved.anyOf.some((s) => matchesSchemaType(value, s, root));
  if (resolved.allOf?.length) return resolved.allOf.every((s) => matchesSchemaType(value, s, root));
  if (resolved.enum && !resolved.enum.includes(value)) return false;

  switch (resolved.type) {
    case undefined:
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array": {
      if (!Array.isArray(value)) return false;
      if (!resolved.items) return true;
      if (Array.isArray(resolved.items)) return true;
      return value.every((v) => matchesSchemaType(v, resolved.items as JsonSchema, root));
    }
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

export function validateParamsAgainstSchema(
  method: string,
  params: Record<string, unknown>,
  schema?: JsonSchema,
): void {
  if (!schema) return;
  const root = schema;
  const resolvedSchema = resolveSchema(schema, root) ?? schema;
  if (resolvedSchema.type !== "object") return;

  const required = resolvedSchema.required ?? [];
  const missing = required.filter((k) => !(k in params));
  if (missing.length > 0) {
    throw new Error(`Missing required params for ${method}: ${missing.join(", ")}`);
  }

  // Closed unless the schema opens itself (`additionalProperties: true` or a
  // schema, as the passthrough webhook targets do). Zod's input schemas say
  // nothing either way, and reading silence as "anything goes" let a typo, or
  // a param the method doesn't have, slip through while the CLI filled `cwd`
  // in from the shell: `delete_workspace --id X` once deleted the shell's
  // workspace instead of X. A flag the method doesn't know is an error.
  const properties = resolvedSchema.properties ?? {};
  const open =
    resolvedSchema.additionalProperties !== undefined &&
    resolvedSchema.additionalProperties !== false;
  if (!open) {
    const allowed = Object.keys(properties);
    const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      const takes = allowed.length > 0 ? `it takes ${allowed.join(", ")}` : "it takes no params";
      throw new Error(`Unknown params for ${method}: ${unknown.join(", ")} (${takes})`);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const propSchema = properties[key];
    if (!propSchema) continue;
    if (!matchesSchemaType(value, propSchema, root)) {
      const expectedType = schemaType(propSchema, root);
      const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      throw new Error(
        `Invalid type for ${method}.${key}: expected ${expectedType}, got ${actualType}`,
      );
    }
  }
}

/**
 * Pull `--out <path>` out of the raw args.
 *
 * Handled by the CLI rather than the gateway: the file belongs on the machine
 * that ran the command, which is not necessarily the one running Chrome. No
 * method declares it, so it has to come out before schema validation.
 */
export function extractOutFlag(args: string[]): { args: string[]; outPath?: string } {
  const index = args.indexOf("--out");
  if (index === -1) return { args };

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--out requires a file path, e.g. --out shot.png");
  }
  return { args: [...args.slice(0, index), ...args.slice(index + 2)], outPath: value };
}

const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Write a result to disk, decoding a base64 data: URI to real bytes.
 *
 * That decoding is the whole point: `screenshot` returns a
 * `data:image/png;base64,…` string, so saving one previously meant piping the
 * JSON through a few lines of scripting to strip the prefix and decode it —
 * every single time.
 */
export async function writeResultToFile(
  result: unknown,
  outPath: string,
): Promise<{ path: string; bytes: number; mediaType?: string }> {
  const match = typeof result === "string" ? result.match(DATA_URI) : null;
  if (match) {
    const bytes = Buffer.from(match[2], "base64");
    await Bun.write(outPath, bytes);
    return { path: outPath, bytes: bytes.length, mediaType: match[1] };
  }

  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  await Bun.write(outPath, text);
  return { path: outPath, bytes: Buffer.byteLength(text) };
}

export function injectSessionIdFromEnv(
  params: Record<string, unknown>,
  methodDef: MethodCatalogEntry,
  resolvedMethod: string,
  env: Record<string, string | undefined> = process.env,
): InjectSessionIdResult {
  if (params.sessionId || !methodDef.inputSchema) {
    return { didInject: false };
  }

  const schema =
    resolveSchema(methodDef.inputSchema, methodDef.inputSchema) ?? methodDef.inputSchema;
  const hasSessionId = schema.type === "object" && schema.properties?.sessionId;
  if (!hasSessionId) return { didInject: false };

  const isRequired = schema.required?.includes("sessionId") ?? false;
  if (env.ANIMA_SESSION_ID) {
    params.sessionId = env.ANIMA_SESSION_ID;
    return { didInject: true };
  }
  if (isRequired) {
    return {
      didInject: false,
      error: `${resolvedMethod} requires --sessionId but $ANIMA_SESSION_ID is not set.`,
    };
  }

  return { didInject: false };
}

/**
 * Auto-inject `launchedBySessionId` from `$ANIMA_SESSION_ID` when the method
 * takes one (create_session, spawn_agent) and the caller didn't pass it, so a
 * session started from inside another one nests under its launcher in the nav
 * without any skill or brief having to remember a flag. Outside an
 * Anima session there is no launcher, and nothing is injected.
 */
export function injectLauncherFromEnv(
  params: Record<string, unknown>,
  methodDef: MethodCatalogEntry,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (params.launchedBySessionId || !env.ANIMA_SESSION_ID || !methodDef.inputSchema) return false;

  const schema =
    resolveSchema(methodDef.inputSchema, methodDef.inputSchema) ?? methodDef.inputSchema;
  if (schema.type !== "object" || !schema.properties?.launchedBySessionId) return false;

  params.launchedBySessionId = env.ANIMA_SESSION_ID;
  return true;
}

/**
 * Auto-inject `cwd` from process.cwd() when the method schema has an
 * optional `cwd` property and the caller didn't provide one explicitly.
 * This lets users run `anima session get_memory_context` without --cwd.
 */
export function injectCwdFromProcess(
  params: Record<string, unknown>,
  methodDef: MethodCatalogEntry,
): void {
  if (params.cwd) return;
  if (!methodDef.inputSchema) return;

  const schema =
    resolveSchema(methodDef.inputSchema, methodDef.inputSchema) ?? methodDef.inputSchema;
  const hasCwd = schema.type === "object" && schema.properties?.cwd;
  if (!hasCwd) return;

  params.cwd = process.cwd();
}

export function splitMethod(method: string): { namespace: string; action: string } | null {
  const idx = method.indexOf(".");
  if (idx <= 0 || idx >= method.length - 1) return null;
  return {
    namespace: method.slice(0, idx),
    action: method.slice(idx + 1),
  };
}

export function formatFlagPlaceholder(name: string, required: boolean): string {
  const token = name.toUpperCase();
  return required ? `<${token}>` : `[${token}]`;
}

export function formatMethodCommand(entry: MethodCatalogEntry): string {
  const split = splitMethod(entry.method);
  if (!split) return `anima ${entry.method}`;

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    return `anima ${split.namespace} ${split.action}`;
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ? Object.entries(schema.properties) : [];
  const flagParts = props.map(
    ([name]) => `--${name} ${formatFlagPlaceholder(name, required.has(name))}`,
  );

  const suffix = flagParts.length > 0 ? ` ${flagParts.join(" ")}` : "";
  return `anima ${split.namespace} ${split.action}${suffix}`;
}

export function printMethodHelp(entry: MethodCatalogEntry): void {
  const split = splitMethod(entry.method);
  const command = split ? `anima ${split.namespace} ${split.action}` : `anima ${entry.method}`;

  console.log(`\n`);
  if (entry.description) console.log(`  ${entry.description}`);
  console.log(`  Usage: ${formatMethodCommand(entry)}`);

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    console.log("  No input schema available.");
    return;
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ? Object.entries(schema.properties) : [];
  if (props.length === 0) {
    console.log("  No parameters.");
    return;
  }

  console.log("  Parameters:");
  for (const [name, prop] of props) {
    const req = required.has(name) ? "required" : "optional";
    const resolvedProp = resolveSchema(prop, rootSchema) ?? prop;
    const type = schemaType(resolvedProp, rootSchema);
    const desc = resolvedProp.description ? ` - ${resolvedProp.description}` : "";
    const placeholder = formatFlagPlaceholder(name, required.has(name));
    console.log(`    --${name} ${placeholder} (${type}, ${req})${desc}`);
  }
}

export function exampleValueForSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema | undefined,
): string {
  const resolved = resolveSchema(schema, root) ?? schema;
  if (!resolved) return '"value"';

  if (resolved.enum && resolved.enum.length > 0) {
    return JSON.stringify(resolved.enum[0]);
  }

  if (resolved.anyOf && resolved.anyOf.length > 0) {
    return exampleValueForSchema(resolved.anyOf[0], root);
  }
  if (resolved.allOf && resolved.allOf.length > 0) {
    return exampleValueForSchema(resolved.allOf[0], root);
  }

  switch (resolved.type) {
    case "string":
      return '"value"';
    case "number":
      return "1.23";
    case "integer":
      return "1";
    case "boolean":
      return "true";
    case "null":
      return "null";
    case "array":
      if (Array.isArray(resolved.items) || !resolved.items) return "'[]'";
      return `'[${exampleValueForSchema(resolved.items, root)}]'`;
    case "object":
      return "'{}'";
    default:
      return '"value"';
  }
}

export function printMethodExamples(entry: MethodCatalogEntry): void {
  const split = splitMethod(entry.method);
  const command = split ? `${split.namespace} ${split.action}` : entry.method;
  console.log(`\nanima ${command} examples`);

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    console.log(`  anima ${command}`);
    return;
  }

  const props = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  if (!split) {
    console.log(`  anima ${entry.method}`);
    return;
  }

  const requiredFlags = props
    .filter(([name]) => required.has(name))
    .map(([name, prop]) => `--${name} ${exampleValueForSchema(prop, rootSchema)}`);

  const optionalFlags = props
    .filter(([name]) => !required.has(name))
    .map(([name, prop]) => `--${name} ${exampleValueForSchema(prop, rootSchema)}`);

  if (requiredFlags.length === 0 && optionalFlags.length === 0) {
    console.log(`  anima ${split.namespace} ${split.action}`);
    return;
  }

  const requiredCmd = `anima ${split.namespace} ${split.action} ${requiredFlags.join(" ")}`.trim();
  console.log(`  ${requiredCmd}`);

  if (optionalFlags.length > 0) {
    const mixed =
      `${requiredCmd} ${optionalFlags.slice(0, Math.min(2, optionalFlags.length)).join(" ")}`.trim();
    console.log(`  ${mixed}`);
  }
}

export function getNamespaces(methods: MethodCatalogEntry[]): string[] {
  const names = new Set<string>();
  for (const m of methods) {
    const split = splitMethod(m.method);
    names.add(split ? split.namespace : m.method);
  }
  return Array.from(names).sort();
}

export function printNamespaceHelp(
  namespace: string,
  methods: MethodCatalogEntry[],
  extensionCli?: ExtensionCli | null,
): void {
  const rows = methods
    .filter((m) => splitMethod(m.method)?.namespace === namespace)
    .sort((a, b) => a.method.localeCompare(b.method));
  const local = extensionCli ? formatLocalCommands(namespace, extensionCli) : [];

  if (rows.length === 0 && local.length === 0) {
    console.error(`Unknown namespace: ${namespace}`);
    return;
  }

  console.log(`\nNamespace: ${namespace}`);
  if (local.length > 0) {
    console.log("\n  Local commands (run on this machine):");
    for (const line of local) console.log(`    ${line}`);
    if (rows.length > 0) console.log("\n  Gateway methods:");
  }
  const indent = local.length > 0 ? "    " : "  ";
  for (const entry of rows) {
    console.log(`${indent}${formatMethodCommand(entry)}`);
  }
}

export function printMethodList(methods: MethodCatalogEntry[], namespace?: string): void {
  const sorted = [...methods].sort((a, b) => a.method.localeCompare(b.method));
  const filtered = namespace
    ? sorted.filter((m) => splitMethod(m.method)?.namespace === namespace)
    : sorted;

  if (namespace && filtered.length === 0) {
    console.error(`Unknown namespace: ${namespace}`);
    return;
  }

  console.log("Available commands:\n");
  for (const entry of filtered) {
    console.log(`  ${formatMethodCommand(entry)}`);
  }
}

export function printCliHelp(methods: MethodCatalogEntry[], localNamespaces: string[] = []): void {
  console.log("Anima CLI — gateway client for the Anima AI assistant platform.\n");
  console.log("Usage:\n");
  console.log("  anima <namespace> <action> --param value  Call a method");
  console.log("  anima <namespace> <action> --help          Show method help");
  console.log("  anima <namespace> <action> --examples      Show usage examples");
  console.log("  anima <namespace> --help                   List namespace methods");
  console.log("  anima methods [namespace]                  List all available methods");
  console.log("  anima doctor                               Run local hardening checks");
  console.log("  (global) --host <host[:port]>                Override gateway host for this call");
  console.log("  (global) --gateway-url <ws(s)://.../ws>      Override full gateway URL");

  console.log("\nParam names:\n");
  console.log("  Flags are matched ignoring case, hyphens, and underscores —");
  console.log("  --session-id, --session_id and --sessionId are all the same param.");

  console.log("\nNamespaces:\n");
  for (const ns of [...new Set([...getNamespaces(methods), ...localNamespaces])].sort()) {
    console.log(`  ${ns}`);
  }

  console.log("\nSession ID:\n");
  console.log("  Commands that require a --sessionId will auto-detect it from the");
  console.log("  $ANIMA_SESSION_ID environment variable. When running inside a");
  console.log("  Anima session, this is set automatically — one will be provided");
  console.log("  for you at no extra charge. Pass --sessionId explicitly to override.");
}

async function fetchMethodCatalog(): Promise<MethodCatalogEntry[]> {
  const client = createGatewayClient({ url: gatewayUrl });
  try {
    const payload = (await client.call("gateway.list_methods", {})) as {
      methods?: MethodCatalogEntry[];
    };
    return payload.methods ?? [];
  } finally {
    client.disconnect();
  }
}

async function invokeMethod(
  method: string,
  params: Record<string, unknown>,
  outPath?: string,
): Promise<void> {
  // The gateway gives an extension request up to 5 minutes. Waiting less here
  // only abandons a call the server is still doing (a handoff that bootstraps
  // a worktree can take a minute), and the caller never learns how it ended.
  const client = createGatewayClient({ url: gatewayUrl, requestTimeoutMs: 300_000 });
  const streamPrompt = method === "session.send_prompt";
  let stopStreamResolve: (() => void) | null = null;
  const stopStream = new Promise<void>((resolve) => {
    stopStreamResolve = resolve;
  });
  let unsub: (() => void) | null = null;

  try {
    if (streamPrompt) {
      // Only the target session's stream. Subscribing to `session.*` printed
      // whatever any other session happened to be saying at the time, and
      // stopped at the first `message_stop` from any of them.
      const streamPattern = `session.${String(params.sessionId)}.*`;
      unsub = client.on(streamPattern, (event, payload) => {
        const streamPayload = (payload || {}) as Record<string, unknown>;

        if (event.includes(".content_block_delta")) {
          const delta = streamPayload.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            process.stdout.write(delta.text);
          }
        }

        if (event.includes(".message_stop")) {
          process.stdout.write("\n");
          stopStreamResolve?.();
        }
      });

      await client.subscribe([streamPattern]);
    }

    const payload = await client.call(method, params);
    if (!streamPrompt) {
      if (outPath) {
        const written = await writeResultToFile(payload, outPath);
        const kind = written.mediaType ? `${written.mediaType}, ` : "";
        console.log(`Wrote ${written.path} (${kind}${written.bytes} bytes)`);
        return;
      }
      if (payload !== undefined) {
        console.log(JSON.stringify(payload, null, 2));
      }
      return;
    }

    await Promise.race([stopStream, Bun.sleep(1500)]);
  } finally {
    unsub?.();
    client.disconnect();
  }
}

// ── Watchdog CLI ─────────────────────────────────────────

/** watchdog.json for this instance (same lookup as the watchdog's own). */
function watchdogConfigPath(): string {
  return process.env.ANIMA_WATCHDOG_CONFIG || join(animaConfigHome(), ".anima", "watchdog.json");
}

/**
 * `ANIMA_WATCHDOG_URL`, else localhost on `ANIMA_WATCHDOG_PORT`, the `port` in
 * watchdog.json, or 30085.
 */
function defaultWatchdogUrl(): string {
  if (process.env.ANIMA_WATCHDOG_URL) return process.env.ANIMA_WATCHDOG_URL;
  let port = envPort("ANIMA_WATCHDOG_PORT");
  if (!port) {
    try {
      const parsed = JSON.parse(readFileSync(watchdogConfigPath(), "utf-8")) as { port?: number };
      if (typeof parsed.port === "number") port = parsed.port;
    } catch {
      // No watchdog.json: the default port.
    }
  }
  return `http://localhost:${port ?? DEFAULT_WATCHDOG_PORT}`;
}

const WATCHDOG_URL = defaultWatchdogUrl();

/**
 * The launchd label for this instance's watchdog (`ANIMA_WATCHDOG_LABEL`,
 * default `com.anima.watchdog`). `install`, `uninstall` and `reload` act on the
 * LaunchAgent with this label, so a second instance needs its own.
 */
const WATCHDOG_LABEL = process.env.ANIMA_WATCHDOG_LABEL || "com.anima.watchdog";

/** Instance env vars written into the LaunchAgent so the watchdog finds this instance. */
const INSTANCE_ENV_VARS = [
  "ANIMA_HOME",
  "ANIMA_CONFIG",
  "ANIMA_DATA_DIR",
  "ANIMA_MEMORY_DIR",
  "ANIMA_WATCHDOG_CONFIG",
  "ANIMA_WATCHDOG_PORT",
  "ANIMA_GATEWAY_PORT",
  "ANIMA_AGENT_HOST_PORT",
  "ANIMA_GATEWAY_URL",
  "ANIMA_TMUX_PREFIX",
] as const;

/**
 * What `anima watchdog install` writes into the LaunchAgent's environment: the
 * instance's paths and ports, plus settings that aren't about which instance
 * this is (so they don't count as "isolated" above) but must survive launchd.
 */
const LAUNCHD_ENV_VARS = [
  ...INSTANCE_ENV_VARS,
  "ANIMA_WATCHDOG_LABEL",
  "ANIMA_SKIP_CLAUDE_UPDATE",
] as const;

/**
 * Refuse to touch the default LaunchAgent from a non-default instance: it
 * belongs to the instance on the default paths, and reloading it restarts
 * that instance's whole stack.
 */
function assertOwnWatchdogLabel(): void {
  const isolated = INSTANCE_ENV_VARS.some((key) => process.env[key]);
  if (isolated && WATCHDOG_LABEL === "com.anima.watchdog") {
    console.error(
      "Error: this shell points at a non-default Anima instance (ANIMA_* env is set), but " +
        "ANIMA_WATCHDOG_LABEL is not, so this would act on the default instance's watchdog " +
        "(com.anima.watchdog). Set ANIMA_WATCHDOG_LABEL to a label of its own, e.g. " +
        "com.anima.watchdog.open-anima.",
    );
    process.exit(1);
  }
}

function watchdogPlistPath(): string {
  return `${process.env.HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist`;
}

/** Derive the gateway's HTTP /health URL from the (ws) gateway URL. */
function gatewayHealthUrl(): string {
  // ws:// → http://, wss:// → https://
  const url = new URL(gatewayUrl.replace(/^ws/, "http"));
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

function getAuthHeaders(): Record<string, string> {
  try {
    const token = loadConfig().gateway?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

type DoctorLevel = "pass" | "warn" | "fail";

interface DoctorCheck {
  level: DoctorLevel;
  name: string;
  detail?: string;
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function runCapture(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(result.stdout);
}

function addPermissionCheck(checks: DoctorCheck[], path: string, required: boolean): void {
  try {
    if (!existsSync(path)) {
      checks.push({
        level: required ? "fail" : "warn",
        name: `${path} exists`,
        detail: "not found",
      });
      return;
    }
    const stat = statSync(path);
    const mode = stat.mode & 0o777;
    checks.push({
      level: (mode & 0o077) === 0 ? "pass" : "fail",
      name: `${path} owner-only permissions`,
      detail: modeString(mode),
    });
  } catch (error) {
    checks.push({ level: "fail", name: `${path} permissions`, detail: String(error) });
  }
}

function addListenerCheck(
  checks: DoctorCheck[],
  lsofOutput: string,
  port: number,
  name: string,
): void {
  const lines = lsofOutput
    .split("\n")
    .filter((line) => line.includes(`:${port} `) || line.includes(`:${port} (LISTEN)`));
  const hasLoopback = lines.some((line) => line.includes(`TCP 127.0.0.1:${port} (LISTEN)`));
  const hasWildcard = lines.some((line) =>
    /\sTCP\s+(?:\*|0\.0\.0\.0|\[?::\]?):\d+\s+\(LISTEN\)/.test(line),
  );

  if (hasLoopback && !hasWildcard) {
    checks.push({ level: "pass", name: `${name} listens on 127.0.0.1:${port}` });
  } else if (hasWildcard) {
    checks.push({
      level: "fail",
      name: `${name} loopback bind`,
      detail: lines.join(" | "),
    });
  } else {
    checks.push({ level: "warn", name: `${name} listener`, detail: `port ${port} not listening` });
  }
}

async function addHttpStatusCheck(
  checks: DoctorCheck[],
  name: string,
  url: string,
  expectedStatus: number,
  headers?: Record<string, string>,
): Promise<void> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2500),
    });
    checks.push({
      level: res.status === expectedStatus ? "pass" : "fail",
      name,
      detail: `HTTP ${res.status}, expected ${expectedStatus}`,
    });
  } catch (error) {
    checks.push({ level: "fail", name, detail: String(error) });
  }
}

function printDoctorChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const label = check.level === "pass" ? "PASS" : check.level === "warn" ? "WARN" : "FAIL";
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${label.padEnd(4)} ${check.name}${detail}`);
  }
}

async function doctorCommand(_args: string[]): Promise<void> {
  const checks: DoctorCheck[] = [];
  const homeDir = process.env.HOME || "";
  const authHeaders = getAuthHeaders();
  const hasToken = Boolean(authHeaders.Authorization);
  const config = (() => {
    try {
      return loadConfig();
    } catch {
      return null;
    }
  })();
  const gatewayPort = config?.gateway.port ?? DEFAULT_GATEWAY_PORT;
  const agentHostPort = config?.agentHost.port ?? 30087;
  const watchdogPort = (() => {
    try {
      return Number(new URL(WATCHDOG_URL).port || "80");
    } catch {
      return DEFAULT_WATCHDOG_PORT;
    }
  })();

  checks.push({
    level: hasToken ? "pass" : "fail",
    name: "gateway token configured",
  });

  if (homeDir) {
    const configDir = resolve(animaConfigHome(), ".anima");
    addPermissionCheck(checks, configDir, true);
    addPermissionCheck(checks, resolve(configDir, "anima.json"), true);
    addPermissionCheck(checks, watchdogConfigPath(), true);
    if (resolve(animaDataDir()) !== configDir) addPermissionCheck(checks, animaDataDir(), true);
    addPermissionCheck(checks, resolve(animaDataDir(), "bin", "watchdog"), false);
  }
  addPermissionCheck(checks, resolve(process.cwd(), ".env"), false);

  const lsofOutput = runCapture(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);
  addListenerCheck(checks, lsofOutput, watchdogPort, "watchdog");
  addListenerCheck(checks, lsofOutput, gatewayPort, "gateway");
  addListenerCheck(checks, lsofOutput, agentHostPort, "agent-host");

  await addHttpStatusCheck(
    checks,
    "watchdog rejects unauthenticated status",
    `${WATCHDOG_URL}/status`,
    401,
  );
  await addHttpStatusCheck(
    checks,
    "watchdog accepts authenticated status",
    `${WATCHDOG_URL}/status`,
    200,
    authHeaders,
  );
  await addHttpStatusCheck(
    checks,
    "agent-host rejects unauthenticated health",
    `http://127.0.0.1:${agentHostPort}/health`,
    401,
  );
  await addHttpStatusCheck(
    checks,
    "agent-host accepts authenticated health",
    `http://127.0.0.1:${agentHostPort}/health`,
    200,
    authHeaders,
  );
  await addHttpStatusCheck(
    checks,
    "gateway rejects unauthenticated health",
    `http://127.0.0.1:${gatewayPort}/health`,
    401,
  );
  await addHttpStatusCheck(
    checks,
    "gateway accepts authenticated health",
    `http://127.0.0.1:${gatewayPort}/health`,
    200,
    authHeaders,
  );

  const failCount = checks.filter((check) => check.level === "fail").length;
  const warnCount = checks.filter((check) => check.level === "warn").length;
  printDoctorChecks(checks);
  console.log(`\n${failCount} failed, ${warnCount} warning(s)`);
  if (failCount > 0) process.exit(1);
}

const WATCHDOG_METHODS: MethodCatalogEntry[] = [
  {
    method: "watchdog.status",
    source: "gateway",
    description: "Show watchdog and service health status",
  },
  {
    method: "watchdog.health_check",
    source: "gateway",
    description:
      "Full system health — gateway /health aggregate (extensions, locks, client beacon). Pass --json for the raw payload.",
  },
  {
    method: "watchdog.restart",
    source: "gateway",
    description: "Restart a managed service (gateway or runtime)",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service to restart: gateway or runtime" },
      },
      required: ["service"],
    },
  },
  {
    method: "watchdog.logs",
    source: "gateway",
    description: "List available log files",
  },
  {
    method: "watchdog.log_tail",
    source: "gateway",
    description: "Tail a log file",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Log file name (e.g. gateway.log)" },
        lines: { type: "integer", description: "Number of lines to show (default: 50)" },
      },
      required: ["file"],
    },
  },
  {
    method: "watchdog.reload",
    source: "gateway",
    description:
      "Reload the watchdog via launchd unload/load — picks up new env vars from ~/.zshrc",
  },
  {
    method: "watchdog.install",
    source: "gateway",
    description: "Install watchdog as a launchd service (start on login)",
  },
  {
    method: "watchdog.uninstall",
    source: "gateway",
    description: "Uninstall watchdog launchd service",
  },
];

function escapePlistValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderWatchdogPlist(params: {
  homeDir: string;
  projectDir: string;
  executable: string[];
}): string {
  const programArguments = params.executable
    .map((arg) => `    <string>${escapePlistValue(arg)}</string>`)
    .join("\n");
  const instanceEnv = LAUNCHD_ENV_VARS.filter((key) => process.env[key])
    .map(
      (key) =>
        `    <key>${key}</key>\n    <string>${escapePlistValue(process.env[key] ?? "")}</string>`,
    )
    .join("\n");
  const launchdLog = resolve(animaDataDir(), "logs", "watchdog-launchd.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlistValue(WATCHDOG_LABEL)}</string>

  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>

  <key>WorkingDirectory</key>
  <string>${escapePlistValue(params.projectDir)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapePlistValue(process.env.PATH || "")}</string>
    <key>HOME</key>
    <string>${escapePlistValue(params.homeDir)}</string>
    <key>ANIMA_PROJECT_DIR</key>
    <string>${escapePlistValue(params.projectDir)}</string>
${instanceEnv}
  </dict>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapePlistValue(launchdLog)}</string>

  <key>StandardErrorPath</key>
  <string>${escapePlistValue(launchdLog)}</string>
</dict>
</plist>
`;
}

function getWatchdogLaunchCommand(projectDir: string): string[] {
  // Where `bun run watchdog:deploy` installs it: `<data dir>/bin/watchdog`.
  const deployedBinary = resolve(animaDataDir(), "bin", "watchdog");
  if (existsSync(deployedBinary)) {
    return [deployedBinary];
  }

  const bunPath = process.execPath;
  return [bunPath, "run", "watchdog"];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function watchdogCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help") {
    console.log("\nwatchdog commands:\n");
    console.log("  anima watchdog status                  Show service health");
    console.log(
      "  anima watchdog health_check [--json]   Full system health (gateway + all extensions + locks)",
    );
    console.log(
      "  anima watchdog restart <service> [--force]  Restart a service from watchdog.json",
    );
    console.log(
      "  anima watchdog reload                  Reload the watchdog itself via launchd (picks up new env vars)",
    );
    console.log("  anima watchdog logs                    List available log files");
    console.log("  anima watchdog logs <file> [lines]     Tail a log file");
    console.log("  anima watchdog install                 Install as launchd service");
    console.log("  anima watchdog uninstall               Uninstall launchd service");
    return;
  }

  if (sub === "status") {
    try {
      const res = await fetch(`${WATCHDOG_URL}/status`, {
        signal: AbortSignal.timeout(3000),
        headers: getAuthHeaders(),
      });
      const data = (await res.json()) as Record<
        string,
        {
          name: string;
          processAlive: boolean;
          healthy: boolean;
          consecutiveFailures: number;
          lastRestart: string | null;
          healthReason?: string | null;
        }
      >;
      console.log();
      for (const [id, s] of Object.entries(data)) {
        if (typeof s.processAlive !== "boolean") {
          const healthy = (s as { healthy?: boolean }).healthy === true;
          const dot = healthy ? "\x1b[32m●\x1b[0m" : "\x1b[33m●\x1b[0m";
          console.log(`  ${dot} ${s.name || id} ${healthy ? "healthy" : "unhealthy"}`);
          continue;
        }
        const dot = s.healthy
          ? "\x1b[32m●\x1b[0m"
          : s.processAlive
            ? "\x1b[33m●\x1b[0m"
            : "\x1b[31m●\x1b[0m";
        const status = s.healthy ? "healthy" : s.processAlive ? "unhealthy" : "down";
        const restart = s.lastRestart ? new Date(s.lastRestart).toLocaleTimeString() : "never";
        const reason = s.healthy ? "" : `  reason: ${s.healthReason || "n/a"}`;
        console.log(
          `  ${dot} ${s.name.padEnd(10)} ${status.padEnd(12)} failures: ${s.consecutiveFailures}  last restart: ${restart}${reason}`,
        );
      }
      console.log();
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      console.error("Is the watchdog running? Start with: bun run watchdog");
      process.exit(1);
    }
    return;
  }

  if (sub === "health_check" || sub === "health") {
    const asJson = args.includes("--json");
    try {
      const res = await fetch(gatewayHealthUrl(), {
        signal: AbortSignal.timeout(5000),
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        console.error(`Error: gateway /health returned ${res.status}`);
        process.exit(1);
      }
      const data = (await res.json()) as {
        status: string;
        clients: number;
        extensions: Record<string, { ok: boolean; error?: string }>;
        extensionLocks?: { extensionId: string; stale: boolean }[];
        client?: { healthy: boolean; recentErrors?: number };
      };
      if (asJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const okDot = "\x1b[32m●\x1b[0m";
      const badDot = "\x1b[31m●\x1b[0m";
      const gatewayOk = data.status === "ok";
      console.log();
      console.log(
        `  Gateway: ${gatewayOk ? `${okDot} ok` : `${badDot} ${data.status}`}  clients: ${data.clients}`,
      );
      console.log();
      const extensions = Object.entries(data.extensions ?? {});
      for (const [id, ext] of extensions) {
        console.log(
          ext.ok ? `  ${okDot} ${id}` : `  ${badDot} ${id} — ${ext.error ?? "unhealthy"}`,
        );
      }
      const staleLocks = (data.extensionLocks ?? []).filter((l) => l.stale);
      if (staleLocks.length > 0) {
        console.log(`\n  ⚠ stale locks: ${staleLocks.map((l) => l.extensionId).join(", ")}`);
      }
      if (data.client) {
        console.log(
          `\n  Web client beacon: ${data.client.healthy ? `${okDot} healthy` : `${badDot} unhealthy`}  recent errors: ${data.client.recentErrors ?? 0}`,
        );
      }
      console.log();
      if (!gatewayOk || extensions.some(([, ext]) => !ext.ok)) process.exit(1);
    } catch {
      console.error("Error: Could not reach gateway /health at", gatewayHealthUrl());
      console.error("Is the gateway running? Check: anima watchdog status");
      process.exit(1);
    }
    return;
  }

  if (sub === "restart") {
    const service = args[1];
    const force = args.includes("--force");
    if (!service) {
      console.error(
        "Usage: anima watchdog restart <service> [--force]  (a service id from watchdog.json, e.g. gateway, agent-host)",
      );
      process.exit(1);
    }
    try {
      const suffix = force ? "?force=1" : "";
      const res = await fetch(`${WATCHDOG_URL}/restart/${service}${suffix}`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: getAuthHeaders(),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      console.log(data.ok ? `✓ ${data.message}` : `✗ ${data.message}`);
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      process.exit(1);
    }
    return;
  }

  if (sub === "logs") {
    const file = args[1];

    if (!file) {
      // List log files
      try {
        const res = await fetch(`${WATCHDOG_URL}/api/logs`, {
          signal: AbortSignal.timeout(3000),
          headers: getAuthHeaders(),
        });
        const data = (await res.json()) as {
          files: { name: string; size: number; modified: string }[];
        };
        console.log("\nAvailable log files:\n");
        for (const f of data.files) {
          const mod = new Date(f.modified).toLocaleString();
          console.log(`  ${f.name.padEnd(25)} ${formatBytes(f.size).padStart(8)}  ${mod}`);
        }
        console.log(`\nTail a file: anima watchdog logs <filename> [lines]\n`);
      } catch {
        console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
        process.exit(1);
      }
      return;
    }

    // Tail a specific log file
    const lineCount = parseInt(args[2] || "50", 10);
    try {
      const res = await fetch(
        `${WATCHDOG_URL}/api/logs/${encodeURIComponent(file)}?lines=${lineCount}`,
        { signal: AbortSignal.timeout(5000), headers: getAuthHeaders() },
      );
      const data = (await res.json()) as { lines?: string[]; error?: string; fileSize?: number };
      if (data.error) {
        console.error(`Error: ${data.error}`);
        process.exit(1);
      }
      if (data.lines) {
        for (const line of data.lines) {
          // Colorize output
          if (line.includes("[ERROR]")) {
            console.log(`\x1b[31m${line}\x1b[0m`);
          } else if (line.includes("[WARN]")) {
            console.log(`\x1b[33m${line}\x1b[0m`);
          } else {
            console.log(line);
          }
        }
        if (data.fileSize) {
          console.log(
            `\n\x1b[90m--- ${data.lines.length} lines (${formatBytes(data.fileSize)} total) ---\x1b[0m`,
          );
        }
      }
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      process.exit(1);
    }
    return;
  }

  if (sub === "install") {
    assertOwnWatchdogLabel();
    const plistDst = watchdogPlistPath();

    try {
      const homeDir = process.env.HOME;
      if (!homeDir) {
        console.error("Error: HOME is not set");
        process.exit(1);
      }

      const projectDir = resolve(dirname(import.meta.dir), "..", "..");
      const launchCommand = getWatchdogLaunchCommand(projectDir);
      const plist = renderWatchdogPlist({
        homeDir,
        projectDir,
        executable: launchCommand,
      });

      mkdirSync(resolve(homeDir, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(resolve(animaDataDir(), "logs"), { recursive: true });
      await Bun.write(plistDst, plist);
      console.log(`Wrote plist to ${plistDst}`);

      const load = Bun.spawn(["launchctl", "load", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await load.exited;
      console.log("✓ Watchdog installed and loaded. It will start on login.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (sub === "uninstall") {
    assertOwnWatchdogLabel();
    const plistDst = watchdogPlistPath();

    try {
      const unload = Bun.spawn(["launchctl", "unload", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await unload.exited;

      const file = Bun.file(plistDst);
      if (await file.exists()) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(plistDst);
      }
      console.log("✓ Watchdog uninstalled and unloaded.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (sub === "reload") {
    assertOwnWatchdogLabel();
    const plistDst = watchdogPlistPath();
    try {
      console.log("Unloading watchdog...");
      const unload = Bun.spawn(["launchctl", "unload", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await unload.exited;

      console.log("Reloading watchdog (capturing fresh login shell env)...");
      const load = Bun.spawn(["launchctl", "load", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await load.exited;

      console.log("✓ Watchdog reloaded — all services will restart with fresh environment.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown watchdog command: ${sub}`);
  console.error("Run 'anima watchdog --help' for usage.");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────

/**
 * Append the gateway token to the WebSocket URL as a query parameter.
 * Reads from config — no token means no auth (will get rejected by gateway).
 */
function getAuthenticatedGatewayUrl(): string {
  try {
    const config = loadConfig();
    const token = config.gateway?.token;
    if (token) {
      const separator = gatewayUrl.includes("?") ? "&" : "?";
      return `${gatewayUrl}${separator}token=${encodeURIComponent(token)}`;
    }
  } catch {
    // Config not available — proceed without token
  }
  return gatewayUrl;
}

async function main(): Promise<void> {
  const parsed = extractGlobalConnectionArgs(process.argv.slice(2));
  gatewayUrl = parsed.resolvedGatewayUrl;
  const args = parsed.args;

  // ── Token management (local commands, no gateway needed) ──
  if (args[0] === "token") {
    const subcommand = args[1];
    if (subcommand === "generate") {
      const newToken = generateToken();
      writeConfigToken(newToken);
      console.log(`✓ Token generated and saved to ${resolveConfigPath()}\n`);
      console.log(`  ${newToken}\n`);
      console.log("Restart the gateway for the new token to take effect.");
      return;
    }
    if (subcommand === "show") {
      try {
        const config = loadConfig();
        const token = config.gateway?.token;
        if (token) {
          console.log(token);
        } else {
          console.error("No token configured. Run: anima token generate");
          process.exit(1);
        }
      } catch (e) {
        console.error(`Failed to load config: ${e}`);
        process.exit(1);
      }
      return;
    }
    console.error("Usage: anima token generate|show");
    process.exit(1);
  }

  // Inject token into gateway URL for all subsequent calls
  gatewayUrl = getAuthenticatedGatewayUrl();

  if (args[0] === "watchdog") {
    await watchdogCommand(args.slice(1));
    return;
  }

  if (args[0] === "doctor" || args[0] === "audit") {
    await doctorCommand(args.slice(1));
    return;
  }

  // Extension CLI contributions run locally, before (and without) the gateway
  // catalog, so they keep working when the gateway is down.
  const extensionCli = await loadExtensionCli(args[0] ?? "");
  if (extensionCli) {
    const name = args[1];
    if (name && Object.hasOwn(extensionCli.commands, name)) {
      const exitCode = await extensionCli.commands[name].run(args.slice(2), { gatewayUrl });
      process.exit(exitCode ?? 0);
    }
    if (!name || name === "--help") {
      const methods = await fetchMethodCatalog().catch(() => []);
      printNamespaceHelp(args[0], methods, extensionCli);
      return;
    }
  }

  const methods = [...(await fetchMethodCatalog()), ...WATCHDOG_METHODS];
  const methodMap = new Map(methods.map((m) => [m.method, m] as const));

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printCliHelp(methods, listExtensionCliNamespaces());
    return;
  }

  if (args[0] === "methods") {
    printMethodList(methods, args[1]);
    return;
  }

  if (args.length === 2 && args[1] === "--help") {
    printNamespaceHelp(args[0], methods);
    return;
  }

  let resolvedMethod: string | null = null;
  let paramArgs: string[] = [];

  if (args[0].includes(".") && methodMap.has(args[0])) {
    resolvedMethod = args[0];
    paramArgs = args.slice(1);
  } else if (args.length >= 2) {
    const candidate = `${args[0]}.${args[1]}`;
    if (methodMap.has(candidate)) {
      resolvedMethod = candidate;
      paramArgs = args.slice(2);
    }
  }

  if (!resolvedMethod) {
    // Check if the first arg looks like a known namespace
    const namespaces = new Set(methods.map((m) => m.method.split(".")[0]));
    if (namespaces.has(args[0]) || extensionCli) {
      console.error(`Unknown command: ${args[0]} ${args[1] || "?"}\n`);
      printNamespaceHelp(args[0], methods, extensionCli);
    } else {
      console.error(`Unknown command: ${args.join(" ")}\n`);
      printCliHelp(methods, listExtensionCliNamespaces());
    }
    process.exit(1);
  }

  const methodDef = methodMap.get(resolvedMethod)!;

  if (paramArgs.includes("--help")) {
    printMethodHelp(methodDef);
    return;
  }
  if (paramArgs.includes("--examples")) {
    printMethodExamples(methodDef);
    return;
  }

  const { args: methodArgs, outPath } = extractOutFlag(paramArgs);
  const params = parseCliParams(methodArgs, methodDef.inputSchema);

  // Auto-inject sessionId from $ANIMA_SESSION_ID if not explicitly provided
  const injectionResult = injectSessionIdFromEnv(params, methodDef, resolvedMethod);
  if (injectionResult.error) {
    console.error(`Error: ${injectionResult.error}`);
    console.error(`Either pass --sessionId explicitly or run from within a Anima session.\n`);
    printMethodHelp(methodDef);
    process.exit(1);
  }

  // Auto-inject cwd from process.cwd() if the method accepts it and it wasn't provided
  injectCwdFromProcess(params, methodDef);
  injectLauncherFromEnv(params, methodDef);

  validateParamsAgainstSchema(resolvedMethod, params, methodDef.inputSchema);
  await invokeMethod(resolvedMethod, params, outPath);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
