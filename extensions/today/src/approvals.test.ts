import { describe, expect, test } from "bun:test";
import { ASK_FIRST, gateLine } from "./approvals";
import { linearKey, parseTodayConfig } from "./config";
import { launchPrompt } from "./launch";
import type { TodayItem } from "./store";

const review = {
  key: "review:acme/app#12",
  section: "review",
  source: "app:reviews:acme/app",
  title: "#12 Fix the login redirect",
  url: "https://github.com/acme/app/pull/12",
  meta: null,
} as unknown as TodayItem;

describe("approvals", () => {
  test("by default every gate asks: push, merge, post, deploy", () => {
    const config = parseTodayConfig({});
    expect(config.approvals).toEqual(ASK_FIRST);
    const line = gateLine(config.approvals)!;
    expect(line).toContain("push a branch or open or update a PR");
    expect(line).toContain("approve or merge a PR");
    expect(line).toContain("post anything other people see");
    expect(line).toContain("deploy, promote, or run a release workflow");
    expect(line).toContain("wait for my go");
  });

  test("a team loosens one gate on purpose; the rest still ask", () => {
    const config = parseTodayConfig({ approvals: { push: false } });
    expect(config.approvals).toEqual({ push: false, merge: true, post: true, deploy: true });
    expect(gateLine(config.approvals)).not.toContain("push a branch");
    expect(gateLine({ push: false, merge: false, post: false, deploy: false })).toBeNull();
  });

  test("a review session drafts by default, and posts only when the post gate is off", () => {
    const drafted = launchPrompt(review);
    expect(drafted).toContain("draft the review");
    expect(drafted).toContain("Don't post it");
    const posted = launchPrompt(review, undefined, undefined, { ...ASK_FIRST, post: false });
    expect(posted).toContain("post your verdict");
    expect(posted).not.toContain("Don't post it");
  });
});

describe("config defaults", () => {
  test("today is this machine's day unless a zone is set", () => {
    expect(parseTodayConfig({}).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(parseTodayConfig({ timeZone: "Europe/Berlin" }).timeZone).toBe("Europe/Berlin");
  });

  test("Linear is off unless a key is set; a project's key beats the shared one, which beats env", () => {
    const config = parseTodayConfig({ linear: { apiKey: "shared" } });
    const off = parseTodayConfig({});
    expect(linearKey(off, {}, {})).toBeNull();
    expect(linearKey(off, { linear: { promiseLabel: "Promise" } }, {})).toBeNull();
    expect(linearKey(off, { linear: { promiseLabel: "Promise" } }, { LINEAR_API_KEY: "env" })).toBe(
      "env",
    );
    expect(
      linearKey(config, { linear: { promiseLabel: "Promise" } }, { LINEAR_API_KEY: "env" }),
    ).toBe("shared");
    expect(
      linearKey(
        config,
        { linear: { promiseLabel: "Promise", apiKey: "own" } },
        { LINEAR_API_KEY: "env" },
      ),
    ).toBe("own");
    // A project without `linear` never collects it, whatever keys exist.
    expect(linearKey(config, {}, { LINEAR_API_KEY: "env" })).toBeNull();
  });
});
