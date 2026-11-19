/**
 * Notification deliveries: one function per `delivery.type` in config.ts.
 *
 * To add your own, either point a `command` delivery at a script (no code
 * change), or add a case to DeliverySchema and to `deliver` below.
 */

import { homedir } from "node:os";
import type { Delivery } from "./config";

export interface Notification {
  title: string;
  message: string;
  source?: string;
  host: string;
  /** The formatted text (headline, message, origin), as the user reads it. */
  text: string;
}

export interface DeliveryDeps {
  log: (message: string, meta?: Record<string, unknown>) => void;
  run: (argv: string[], stdin: string, timeoutMs: number) => Promise<void>;
  fetch: typeof fetch;
}

/** AppleScript string literal: backslashes and quotes escaped. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function macosScript(notification: Notification, sound?: string): string {
  const subtitle = [notification.source, `on ${notification.host}`].filter(Boolean).join(" ");
  return [
    `display notification ${appleScriptString(notification.message)}`,
    `with title ${appleScriptString(notification.title)}`,
    `subtitle ${appleScriptString(subtitle)}`,
    sound ? `sound name ${appleScriptString(sound)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A header value for `value`. HTTP headers carry only ASCII (fetch throws on
 * anything else), so a title with an emoji or an accent goes as an RFC 2047
 * encoded word, which ntfy decodes back.
 */
export function headerSafe(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

export async function deliver(
  delivery: Delivery,
  notification: Notification,
  deps: DeliveryDeps,
): Promise<{ via: string }> {
  switch (delivery.type) {
    case "log":
      deps.log("Notification", { text: notification.text });
      return { via: "log" };

    case "macos":
      await deps.run(["osascript", "-e", macosScript(notification, delivery.sound)], "", 10_000);
      return { via: "macos" };

    case "command": {
      const [program, ...args] = delivery.argv;
      await deps.run([expandHome(program!), ...args], notification.text, delivery.timeoutMs);
      return { via: `command:${program}` };
    }

    case "webhook": {
      const body =
        delivery.format === "json"
          ? JSON.stringify({
              title: notification.title,
              message: notification.message,
              source: notification.source ?? null,
              host: notification.host,
              text: notification.text,
            })
          : notification.message;
      const headers: Record<string, string> = {
        "Content-Type": delivery.format === "json" ? "application/json" : "text/plain",
        ...(delivery.format === "text" ? { Title: headerSafe(notification.title) } : {}),
        ...delivery.headers,
      };
      let response: Response;
      try {
        response = await deps.fetch(delivery.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(delivery.timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new Error(`Webhook didn't answer within ${delivery.timeoutMs} ms`);
        }
        throw error;
      }
      if (!response.ok) throw new Error(`Webhook answered ${response.status}`);
      return { via: `webhook:${new URL(delivery.url).host}` };
    }
  }
}

/** Run a program with `stdin`, failing on a non-zero exit or the timeout. */
export async function runProgram(argv: string[], stdin: string, timeoutMs: number): Promise<void> {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new Error(`${argv[0]} exited ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
