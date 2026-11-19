import { describe, expect, it } from "bun:test";
import {
  contextTokens,
  contextWindowFor,
  contextZone,
  formatCountdown,
  formatTokens,
  idleCompactionRemainingMs,
} from "./context-window";

const MIN = 60_000;

describe("contextWindowFor", () => {
  it("gives a [1m] model a million tokens", () => {
    expect(contextWindowFor("claude-opus-5-5[1m]")).toBe(1_000_000);
  });

  it("gives any other model, or none, 200K", () => {
    expect(contextWindowFor("claude-opus-5-5")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });
});

describe("contextTokens", () => {
  it("counts everything the call carried in, not what it wrote out", () => {
    expect(
      contextTokens({
        input_tokens: 10,
        cache_read_input_tokens: 300_000,
        cache_creation_input_tokens: 20_000,
        output_tokens: 5_000,
      }),
    ).toBe(320_010);
  });
});

describe("contextZone", () => {
  const oneM = 1_000_000;

  it("is normal under 200K on a 1M window", () => {
    expect(contextZone(0, oneM)).toBe("empty");
    expect(contextZone(199_999, oneM)).toBe("normal");
  });

  it("is ready from idle compaction's 200K floor (20% of 1M)", () => {
    expect(contextZone(200_000, oneM)).toBe("ready");
    expect(contextZone(599_999, oneM)).toBe("ready");
  });

  it("is danger from 60% of the window", () => {
    expect(contextZone(600_000, oneM)).toBe("danger");
  });

  it("goes straight to danger on a 200K window", () => {
    expect(contextZone(119_999, 200_000)).toBe("normal");
    expect(contextZone(120_000, 200_000)).toBe("danger");
  });
});

describe("idleCompactionRemainingMs", () => {
  const idleSince = 1_000_000_000;

  it("stays hidden for the first 50 minutes", () => {
    expect(idleCompactionRemainingMs(320_000, idleSince, idleSince + 49 * MIN)).toBeNull();
  });

  it("counts down from 50 to 54 minutes idle", () => {
    expect(idleCompactionRemainingMs(320_000, idleSince, idleSince + 50 * MIN)).toBe(4 * MIN);
    expect(idleCompactionRemainingMs(320_000, idleSince, idleSince + 53 * MIN)).toBe(MIN);
  });

  it("disappears once the fire point passes", () => {
    expect(idleCompactionRemainingMs(320_000, idleSince, idleSince + 54 * MIN)).toBeNull();
  });

  it("never shows below the 200K floor or without an idle start", () => {
    expect(idleCompactionRemainingMs(199_999, idleSince, idleSince + 52 * MIN)).toBeNull();
    expect(idleCompactionRemainingMs(320_000, null, idleSince + 52 * MIN)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats a countdown as m:ss, rounding up", () => {
    expect(formatCountdown(222_000)).toBe("3:42");
    expect(formatCountdown(59_100)).toBe("1:00");
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("formats tokens compactly", () => {
    expect(formatTokens(320_010)).toBe("320K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(950)).toBe("950");
  });
});
