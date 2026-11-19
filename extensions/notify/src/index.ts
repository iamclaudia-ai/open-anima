#!/usr/bin/env bun
/**
 * Notify Extension — reach the user when they aren't looking.
 *
 * `notify.send` is the one way anything in Anima asks for the user's
 * attention: a scheduled task that broke, an unattended session that is
 * stuck or waiting for a "go", a token about to expire.
 *
 * Where it goes is config (config.ts): the extension log, a macOS
 * notification, your own command, or a webhook. See deliveries.ts.
 *
 * Identical messages inside the dedupe window are sent once, so a loop or a
 * task failing every five minutes can't flood anyone.
 */

import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@anima/shared";
import { z } from "zod";
import { type NotifyConfig, parseNotifyConfig } from "./config";
import { type DeliveryDeps, deliver as deliverTo, runProgram } from "./deliveries";

const MAX_RECENT = 20;

const SendSchema = z.object({
  message: z
    .string()
    .min(1)
    .max(1500)
    .describe("What the user needs to know, in a sentence or two"),
  title: z.string().min(1).max(120).optional().describe("Short headline (default: Anima)"),
  source: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Who is asking: a task, session or extension name"),
  host: z.string().min(1).max(40).optional().describe("Originating host; defaults to this host"),
});

type SendParams = z.infer<typeof SendSchema>;

interface SentRecord {
  at: string;
  text: string;
  via: string;
  ok: boolean;
  error?: string;
  deduped?: boolean;
}

/** The text the user reads: headline, message, and where it came from. */
export function formatNotification(params: SendParams, defaultHost: string): string {
  const origin = [params.source, `on ${params.host ?? defaultHost}`].filter(Boolean).join(" ");
  return `🔔 ${params.title ?? "Anima"}\n${params.message}\n— ${origin}`;
}

/** "10 minutes", "45 seconds": the dedupe window as the method description states it. */
export function describeWindow(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, "hour");
  if (ms % 60_000 === 0) return unit(ms / 60_000, "minute");
  return unit(Math.round(ms / 1000), "second");
}

export function createNotifyExtension(
  rawConfig: Record<string, unknown> = {},
  overrides: Partial<DeliveryDeps> = {},
): AnimaExtension {
  const config: NotifyConfig = parseNotifyConfig(rawConfig);
  let ctx: ExtensionContext | null = null;
  const recent: SentRecord[] = [];
  const lastSentAt = new Map<string, number>();

  function remember(record: SentRecord): void {
    recent.unshift(record);
    recent.length = Math.min(recent.length, MAX_RECENT);
  }

  function deliver(params: SendParams): Promise<{ via: string }> {
    return deliverTo(
      config.delivery,
      {
        title: params.title ?? "Anima",
        message: params.message,
        source: params.source,
        host: params.host ?? config.host,
        text: formatNotification(params, config.host),
      },
      {
        log: (message, meta) => ctx?.log.info(message, meta),
        run: runProgram,
        fetch,
        ...overrides,
      },
    );
  }

  async function send(params: SendParams) {
    const text = formatNotification(params, config.host);
    const now = Date.now();
    const previous = lastSentAt.get(text);
    if (previous !== undefined && now - previous < config.dedupeWindowMs) {
      remember({ at: new Date(now).toISOString(), text, via: "none", ok: true, deduped: true });
      return { sent: false, deduped: true };
    }
    // Claimed before sending, so two identical calls racing each other
    // still produce one message.
    lastSentAt.set(text, now);
    try {
      const { via } = await deliver(params);
      remember({ at: new Date(now).toISOString(), text, via, ok: true });
      ctx?.log.info("Notification sent", { via, source: params.source ?? null });
      return { sent: true, via };
    } catch (error) {
      lastSentAt.delete(text);
      const message = error instanceof Error ? error.message : String(error);
      remember({ at: new Date(now).toISOString(), text, via: "none", ok: false, error: message });
      ctx?.log.error("Notification failed", { error: message });
      throw error;
    }
  }

  const dedupeNote =
    config.dedupeWindowMs > 0
      ? `Identical text within ${describeWindow(config.dedupeWindowMs)} is sent once.`
      : "Every call is delivered (no dedupe window).";
  const methods: ExtensionMethodDefinition[] = [
    {
      name: "notify.send",
      description: `Notify the user through this host's configured delivery (log, macOS notification, command or webhook). For things that need them when they aren't looking: failures, stuck sessions, work waiting for their go-ahead. ${dedupeNote}`,
      inputSchema: SendSchema,
    },
    {
      name: "notify.health_check",
      description: "Notify delivery route and recent sends",
      inputSchema: z.object({}),
    },
  ];
  const schemas = new Map(methods.map((m) => [m.name, m.inputSchema]));

  return {
    id: "notify",
    name: "Notify",
    methods,
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Notify started", { host: config.host, delivery: config.delivery.type });
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string, rawParams: Record<string, unknown>) {
      // The extension host doesn't validate params, so schema defaults only
      // apply if we parse here.
      const schema = schemas.get(method);
      const params = schema ? schema.parse(rawParams) : rawParams;
      switch (method) {
        case "notify.send":
          return send(params as SendParams);

        case "notify.health_check": {
          const failures = recent.filter((r) => !r.ok).length;
          const response: HealthCheckResponse = {
            ok: true,
            status: failures > 0 && recent[0] && !recent[0].ok ? "degraded" : "healthy",
            label: "Notify",
            metrics: [
              { label: "Host", value: config.host },
              { label: "Delivery", value: config.delivery.type },
              { label: "Recent sends", value: recent.length },
              { label: "Recent failures", value: failures },
            ],
            items: recent.slice(0, 5).map((r) => ({
              id: r.at,
              label: r.text.split("\n")[1] ?? r.text,
              status: r.deduped ? "inactive" : r.ok ? "healthy" : "dead",
              details: { at: r.at, via: r.via, ...(r.error ? { error: r.error } : {}) },
            })),
          };
          return response;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: true,
        details: { host: config.host, delivery: config.delivery.type, recent: recent.length },
      };
    },
  };
}

export default createNotifyExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createNotifyExtension);
