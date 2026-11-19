/**
 * Notify configuration: where this host's notifications go.
 *
 *   "notify": { "enabled": true, "config": { "delivery": { "type": "macos" } } }
 *
 * Deliveries (see deliveries.ts):
 *
 *   { "type": "log" }                                  the default: the extension log only
 *   { "type": "macos", "sound": "Glass" }              a macOS notification (osascript)
 *   { "type": "command", "argv": ["~/bin/notify-me"] } your own program; the text arrives on stdin
 *   { "type": "webhook", "url": "https://ntfy.sh/…" }  POST the text (ntfy, Slack incoming webhook, …)
 *
 * `command` is the escape hatch: anything you can script (Pushover, Telegram,
 * a phone bridge, a desk light) becomes a delivery without code here.
 */

import { hostname } from "node:os";
import { z } from "zod";

export const DeliverySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log") }),
  z.object({
    type: z.literal("macos"),
    /** A sound from /System/Library/Sounds, e.g. "Glass". Omit for silence. */
    sound: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("command"),
    /** Program and arguments. The formatted text is written to its stdin. */
    argv: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().optional().default(15_000),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().regex(/^https?:\/\//, "webhook url must be http:// or https://"),
    /**
     * `text` posts the message as plain text with the title in a `Title`
     * header (ntfy's convention; RFC 2047-encoded when it isn't ASCII);
     * `json` posts { title, message, source, host, text }.
     */
    format: z.enum(["text", "json"]).optional().default("text"),
    headers: z.record(z.string(), z.string()).optional().default({}),
    /** A webhook that hasn't answered by then counts as a failed delivery. */
    timeoutMs: z.number().int().positive().optional().default(10_000),
  }),
]);

const ConfigSchema = z.object({
  /** How this host names itself in messages. Defaults to the machine name. */
  host: z.string().min(1).optional(),
  delivery: DeliverySchema.optional().default({ type: "log" }),
  /** Identical text within this window is sent once. */
  dedupeWindowMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(10 * 60_000),
});

export type Delivery = z.infer<typeof DeliverySchema>;

export interface NotifyConfig {
  host: string;
  delivery: Delivery;
  dedupeWindowMs: number;
}

export function parseNotifyConfig(raw: Record<string, unknown>): NotifyConfig {
  const parsed = ConfigSchema.parse(raw);
  return {
    host: parsed.host ?? hostname().replace(/\.local$/, ""),
    delivery: parsed.delivery,
    dedupeWindowMs: parsed.dedupeWindowMs,
  };
}
