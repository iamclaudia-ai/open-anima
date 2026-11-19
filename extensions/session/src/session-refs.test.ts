import { describe, expect, test } from "bun:test";
import type { RefsConfig } from "./session-refs";
import {
  extractRefs,
  extractRefsFromTexts,
  parseGithubRemote,
  readRefsConfig,
} from "./session-refs";

const config: RefsConfig = {
  linear: { prefixes: ["ENG", "WEB", "ENT"], workspace: "acme" },
  github: { defaultRepo: "acme/app", minDigits: 2 },
};

const keys = (text: string, cfg: RefsConfig = config) => extractRefs(text, cfg).map((r) => r.key);

describe("extractRefs — pasted-screenshot placeholders", () => {
  test("ignores Claude Code's [Image #N] markers", () => {
    expect(keys("[Image #9] [Image #10] here's the wizard")).toEqual([]);
    expect(keys("Image #12 shows the banner")).toEqual([]);
  });

  test("still matches a real ref in the same message", () => {
    expect(keys("[Image #3] that's the failure from #1234")).toEqual(["acme/app#1234"]);
  });
});

describe("extractRefs — Linear tickets", () => {
  test("matches configured prefixes", () => {
    expect(keys("let's rename the branch to WEB-42")).toEqual(["WEB-42"]);
    expect(keys("ENG-101 needs a fix first")).toEqual(["ENG-101"]);
    expect(keys("ENT-7 needs a look")).toEqual(["ENT-7"]);
  });

  test("rejects the lookalikes that a naive pattern would match", () => {
    // Each of these turns up in ordinary conversations.
    for (const text of [
      "encode as UTF-8 please",
      "the SHA-256 digest",
      "per RFC-2119 the MUST is binding",
      "timezone is GMT-4",
      "compared against GPT-4",
      "the regex [A-Za-z0-9] with Z0-9 inside",
      "connect via HDMI-2",
      "id a4f2A98C-4 from the uuid",
    ]) {
      expect(keys(text)).toEqual([]);
    }
  });

  test("matches nothing when no prefixes are configured", () => {
    expect(keys("WEB-42 and ENG-101", { github: {} })).toEqual([]);
  });

  test("builds a Linear URL only when the workspace is configured", () => {
    expect(extractRefs("WEB-42", config)[0]?.url).toBe("https://linear.app/acme/issue/WEB-42");
    expect(extractRefs("WEB-42", { linear: { prefixes: ["WEB"] } })[0]?.url).toBeUndefined();
  });

  test("is case-sensitive so prose words don't match", () => {
    expect(keys("the web-42 file")).toEqual([]);
  });
});

describe("extractRefs — GitHub references", () => {
  test("resolves a bare number against the default repo", () => {
    const [ref] = extractRefs("review 1234 — actually #1234 please", config);
    expect(ref?.key).toBe("acme/app#1234");
    expect(ref?.label).toBe("#1234");
    expect(ref?.url).toBe("https://github.com/acme/app/issues/1234");
  });

  test("an explicit repo wins over the default", () => {
    const refs = extractRefs("see acme/anima#65", config);
    expect(refs.map((r) => r.key)).toEqual(["acme/anima#65"]);
    expect(refs[0]?.url).toBe("https://github.com/acme/anima/issues/65");
  });

  test("keeps a bare reference unlinked when no repo is configured", () => {
    const [ref] = extractRefs("look at #412", { github: {} });
    expect(ref?.key).toBe("#412");
    expect(ref?.url).toBeUndefined();
  });

  test("ignores short numbers that are usually prose", () => {
    expect(keys("that's my #1 priority and #2 concern")).toEqual([]);
    expect(keys("issue #42 though")).toEqual(["acme/app#42"]);
  });

  test("ignores a number glued to trailing text", () => {
    expect(keys("color #12ab34")).toEqual([]);
  });

  test("reads a slash command's bare number argument as a PR", () => {
    // The common pattern: skill-launched review sessions pass the PR
    // number as a bare argument with no `#`.
    expect(keys("/review-pr 1234 please take a look")).toEqual(["acme/app#1234"]);
    expect(keys("/review #1234 please")).toEqual(["acme/app#1234"]);
  });

  test("puts the command's own PR first, ahead of ones mentioned in passing", () => {
    const text = "/review-pr 1234 it builds on the part 1 PR (#1201)";
    expect(keys(text)).toEqual(["acme/app#1234", "acme/app#1201"]);
  });

  test("does not read bare numbers outside a command argument", () => {
    expect(keys("we shipped 1234 lines today")).toEqual([]);
    expect(keys("the year 2026 was good")).toEqual([]);
  });

  test("finds references mid-sentence and in lists", () => {
    expect(keys("PRs (#1212, #1214) are ready")).toEqual(["acme/app#1212", "acme/app#1214"]);
  });
});

describe("extractRefs — general behavior", () => {
  test("de-duplicates by key, preserving first-seen order", () => {
    expect(keys("WEB-42 then #1234 then WEB-42 again")).toEqual(["acme/app#1234", "WEB-42"]);
  });

  test("handles empty and irrelevant input", () => {
    expect(extractRefs("", config)).toEqual([]);
    expect(keys("hello, no refs here")).toEqual([]);
  });

  test("extracts a realistic mixed prompt", () => {
    const text =
      "/review-pr 1234 please take a look at this one. " +
      "It builds on the part 1 PR (#1201), which is for WEB-43";
    expect(keys(text)).toEqual(["acme/app#1234", "acme/app#1201", "WEB-43"]);
  });
});

describe("extractRefsFromTexts", () => {
  test("merges across messages, de-duplicated and first-seen ordered", () => {
    const refs = extractRefsFromTexts(["first #1234", "later WEB-42", "again #1234"], config);
    expect(refs.map((r) => r.key)).toEqual(["acme/app#1234", "WEB-42"]);
  });

  test("handles an empty list", () => {
    expect(extractRefsFromTexts([], config)).toEqual([]);
  });
});

describe("readRefsConfig", () => {
  test("reads a well-formed block", () => {
    const parsed = readRefsConfig({
      refs: { linear: { prefixes: ["ENG"], workspace: "acme" }, github: { defaultRepo: "a/b" } },
    });
    expect(parsed.linear?.prefixes).toEqual(["ENG"]);
    expect(parsed.github?.defaultRepo).toBe("a/b");
  });

  test("drops malformed prefixes rather than trusting them", () => {
    // A lowercase or punctuation-bearing prefix would widen matching in ways
    // the operator almost certainly didn't intend.
    const parsed = readRefsConfig({ refs: { linear: { prefixes: ["ENG", "web", 42, "A-B"] } } });
    expect(parsed.linear?.prefixes).toEqual(["ENG"]);
  });

  test("tolerates missing or malformed config", () => {
    expect(readRefsConfig(undefined).linear?.prefixes).toEqual([]);
    expect(readRefsConfig({}).linear?.prefixes).toEqual([]);
    expect(readRefsConfig({ refs: "nope" }).linear?.prefixes).toEqual([]);
  });

  test("defaults minDigits so bare #1 stays out of the nav", () => {
    expect(readRefsConfig({ refs: {} }).github?.minDigits).toBe(2);
  });
});

describe("parseGithubRemote", () => {
  test("reads an SSH remote", () => {
    expect(parseGithubRemote('[remote "origin"]\n\turl = git@github.com:acme/app.git\n')).toBe(
      "acme/app",
    );
  });

  test("reads an HTTPS remote, with or without .git", () => {
    expect(parseGithubRemote("url = https://github.com/acme/anima.git")).toBe("acme/anima");
    expect(parseGithubRemote("url = https://github.com/acme/anima")).toBe("acme/anima");
  });

  test("ignores non-GitHub remotes", () => {
    expect(parseGithubRemote("url = git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGithubRemote("url = https://bitbucket.org/owner/repo.git")).toBeNull();
  });

  test("returns null when there is no remote at all", () => {
    expect(parseGithubRemote("[core]\n\tbare = false\n")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });
});
