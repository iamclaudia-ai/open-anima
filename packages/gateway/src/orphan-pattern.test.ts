import { describe, expect, test } from "bun:test";
import { orphanExtensionHostPattern } from "./orphan-pattern";

describe("orphanExtensionHostPattern", () => {
  const re = new RegExp(orphanExtensionHostPattern("/srv/open-anima"));

  test("matches this checkout's extension hosts", () => {
    expect(re.test("/usr/bin/bun run /srv/open-anima/extensions/session/src/index.ts {}")).toBe(
      true,
    );
    expect(re.test("bun --hot /srv/open-anima/extensions/chat/src/index.ts {}")).toBe(true);
  });

  test("never matches another checkout's", () => {
    expect(re.test("bun run /srv/anima/extensions/session/src/index.ts {}")).toBe(false);
    expect(re.test("bun run /home/x/srv/open-anima/extensions/session/src/index.ts")).toBe(false);
    expect(re.test("bun run /srv/open-anima2/extensions/session/src/index.ts")).toBe(false);
  });

  test("escapes regex characters in the path", () => {
    const dotted = new RegExp(orphanExtensionHostPattern("/srv/a.b"));
    expect(dotted.test("bun run /srv/a.b/extensions/x/src/index.ts")).toBe(true);
    expect(dotted.test("bun run /srv/aXb/extensions/x/src/index.ts")).toBe(false);
  });
});
