import { describe, expect, test } from "bun:test";
import {
  collectDeploys,
  deployToItem,
  newDeployCache,
  newestProdTag,
  parsePathFilters,
  prOfCommit,
  retryTransient,
} from "./deploys";
import type { RunCommand } from "./run";

describe("parsePathFilters", () => {
  test("splits the promote action's list", () => {
    expect(
      parsePathFilters("      with:\n          path-filters: 'apps/api/,packages/shared-ui/'\n"),
    ).toEqual(["apps/api/", "packages/shared-ui/"]);
  });

  test("'.' and no filter both mean the whole repo", () => {
    expect(parsePathFilters("          path-filters: '.'\n")).toEqual([]);
    expect(parsePathFilters("on:\n  workflow_dispatch:\n")).toEqual([]);
  });
});

describe("prOfCommit", () => {
  test("a squash names its PR at the end", () => {
    expect(prOfCommit("fix(nav): reveal the row (#151)\n\nbody")).toEqual({
      number: 151,
      title: "fix(nav): reveal the row",
    });
  });

  test("a merge names it first, with the title after", () => {
    expect(prOfCommit("Merge pull request #152 from acme/alex/x\n\nfix(web): cache")).toEqual({
      number: 152,
      title: "fix(web): cache",
    });
  });

  test("branch commits name no PR", () => {
    expect(prOfCommit("Merge origin/main into alex/fix-cache")).toBeNull();
    expect(prOfCommit("Merge #153 (deps/bump-lodash): fix(deps): bump lodash")).toBeNull();
  });
});

test("newestProdTag compares versions as numbers and ignores other apps", () => {
  expect(newestProdTag("shop", ["shop-prod-v9", "shop-prod-v12", "shop-prod-v11-rc", "x"])).toBe(
    "shop-prod-v12",
  );
  expect(newestProdTag("api", ["api-prod-v8", "api-admin-prod-v10"])).toBe("api-prod-v8");
  expect(newestProdTag("worker", [])).toBeNull();
});

// ── The collector against a fake GitHub ─────────────────────

const NOW = new Date("2026-11-18T16:00:00Z");
const commit = (sha: string, date: string, message: string) =>
  JSON.stringify({ sha, date, message });

/** Two repos: shop (shop + api) and a library with no deploy workflow. */
function fakeGithub(overrides: { live?: Set<string> } = {}) {
  const calls: string[][] = [];
  const live = overrides.live ?? new Set(["old1"]);
  const run: RunCommand = async (argv) => {
    calls.push(argv);
    const [cmd, sub, path] = argv;
    if (cmd !== "gh") throw new Error(`unexpected ${cmd}`);
    if (sub === "search") return JSON.stringify([{ repository: { nameWithOwner: "acme/lib" } }]);
    if (sub !== "api") throw new Error(`unexpected gh ${sub}`);
    if (path === "user") return "alex\n";
    if (path === "graphql") {
      return JSON.stringify({
        repository: {
          a0: { nodes: [{ name: "shop-prod-v9" }, { name: "shop-prod-v10" }] },
          a1: { nodes: [{ name: "api-prod-v4" }] },
        },
      });
    }
    if (path === "repos/acme/shop" || path === "repos/acme/lib") return "main\n";
    if (path === "repos/acme/lib/contents/.github/workflows") {
      throw new Error("gh exited 1: gh: Not Found (HTTP 404)");
    }
    if (path === "repos/acme/shop/contents/.github/workflows") {
      return "ci.yml\nshop-deploy-prod.yml\napi-deploy-prod.yml\nshop-release-prod.yml\n";
    }
    if (path === "repos/acme/shop/contents/.github/workflows/shop-deploy-prod.yml") {
      return "          path-filters: 'app/,client/'\n";
    }
    if (path === "repos/acme/shop/contents/.github/workflows/api-deploy-prod.yml") {
      return "          path-filters: 'apps/api/'\n";
    }
    if (path === "--paginate") {
      const url = argv[3]!;
      if (url.includes("path=app%2F")) {
        return [
          commit("new1", "2026-11-18T10:00:00Z", "feat: too fresh (#5)"),
          commit("mid1", "2026-11-16T10:00:00Z", "feat: waiting (#4)"),
          commit("old1", "2026-11-12T10:00:00Z", "feat: shipped (#2)"),
          commit("older", "2026-11-11T10:00:00Z", "feat: shipped long ago (#1)"),
        ].join("\n");
      }
      if (url.includes("path=client%2F")) {
        return commit("mid1", "2026-11-16T10:00:00Z", "feat: waiting (#4)");
      }
      if (url.includes("path=apps%2Fapi%2F")) {
        // A true merge, seen only through its branch commit.
        return commit("branch1", "2026-11-14T09:00:00Z", "wip: try the thing");
      }
      throw new Error(`unexpected list ${url}`);
    }
    if (path === "repos/acme/shop/commits/branch1/pulls") {
      return JSON.stringify({
        sha: "merge3",
        number: 3,
        title: "fix(api): the thing",
        mergedAt: "2026-11-14T12:00:00Z",
      });
    }
    const compare = path?.match(/^repos\/acme\/shop\/compare\/(.+)\.\.\.(\w+)\?per_page=1$/);
    if (compare) return live.has(compare[2]!) ? "behind\n" : "ahead\n";
    throw new Error(`unexpected gh api ${path}`);
  };
  return { run, calls };
}

const options = (cache = newDeployCache()) => ({
  cwd: "/work/shop",
  repos: ["acme/shop"],
  org: "acme",
  days: 60,
  graceHours: 24,
  now: NOW,
  cache,
});

describe("collectDeploys", () => {
  test("lists merges past the grace period until one production has", async () => {
    const { run, calls } = fakeGithub();
    const items = await collectDeploys(run, options());
    expect(items.map((i) => i.key)).toEqual(["deploy:acme/shop#4:shop", "deploy:acme/shop#3:api"]);
    // #5 is inside the grace period, #2 is live, so #1 is never compared.
    const compared = calls.filter((c) => c[2]?.includes("/compare/")).map((c) => c[2]);
    expect(compared.sort()).toEqual([
      "repos/acme/shop/compare/api-prod-v4...merge3?per_page=1",
      "repos/acme/shop/compare/shop-prod-v10...mid1?per_page=1",
      "repos/acme/shop/compare/shop-prod-v10...old1?per_page=1",
    ]);
    // The fixed repo is left out of the search; the library has no apps and costs nothing more.
    expect(calls.find((c) => c[1] === "search")).toContain("-repo:acme/shop");
    expect(calls.some((c) => c[2]?.startsWith("repos/acme/lib/commits"))).toBe(false);
  });

  test("a path shared by two apps, and a commit's PR, are each read once", async () => {
    const cache = newDeployCache();
    const { run, calls } = fakeGithub();
    await collectDeploys(run, options(cache));
    await collectDeploys(run, options(cache));
    const lookups = calls.filter((c) => c[2] === "repos/acme/shop/commits/branch1/pulls");
    expect(lookups).toHaveLength(1);
    // Apps and the login are cached too: the second pass reads neither again.
    expect(calls.filter((c) => c[2] === "user")).toHaveLength(1);
    expect(calls.filter((c) => c[2] === "repos/acme/shop/contents/.github/workflows")).toHaveLength(
      1,
    );
  });

  test("an item clears once production contains it", async () => {
    const { run } = fakeGithub({ live: new Set(["mid1", "merge3"]) });
    expect(await collectDeploys(run, options())).toEqual([]);
  });
});

test("deployToItem says which app is behind and links the promote", () => {
  const item = deployToItem({
    repo: "acme/shop",
    app: { name: "api", workflow: "api-deploy-prod.yml", paths: ["apps/api/"] },
    tag: "api-prod-v4",
    merge: { sha: "merge3", number: 3, title: "fix: thing", mergedAt: "2026-11-14T12:00:00Z" },
  });
  expect(item).toMatchObject({
    key: "deploy:acme/shop#3:api",
    section: "promote",
    title: "#3 fix: thing",
    url: "https://github.com/acme/shop/pull/3",
    stateLabel: "not in api prod",
    since: "2026-11-14T12:00:00Z",
    meta: {
      promoteUrl: "https://github.com/acme/shop/actions/workflows/api-deploy-prod.yml",
    },
  });
});

test("retryTransient tries a GitHub blip once more, and passes real errors straight on", async () => {
  let calls = 0;
  const flaky: RunCommand = async () => {
    calls++;
    if (calls === 1)
      throw new Error("gh api repos/acme/shop exited 1: Git Repository is empty. (HTTP 409)");
    return "ok";
  };
  expect(await retryTransient(flaky, 0)(["gh"], {})).toBe("ok");
  expect(calls).toBe(2);

  let missing = 0;
  const gone: RunCommand = async () => {
    missing++;
    throw new Error("gh exited 1: gh: Not Found (HTTP 404)");
  };
  await expect(retryTransient(gone, 0)(["gh"], {})).rejects.toThrow("HTTP 404");
  expect(missing).toBe(1);
});
