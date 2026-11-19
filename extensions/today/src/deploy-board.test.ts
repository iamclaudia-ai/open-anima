/** How merged PRs waiting on production behave on the board: Ready to promote, by app. */

import { describe, expect, test } from "bun:test";
import { deployToItem, type Undeployed } from "./collectors/deploys";
import { parseTodayConfig } from "./config";
import { projectSources } from "./index";
import { launchFolder, planStackLaunch, stackFolder, stackPrompt, stackTitle } from "./launch";
import { flagFor, type Item, itemLane, promoteFlag, summarize } from "./pages/model";
import { appGroups, prStacks, stackOf } from "./stacks";
import { applyCollection, listItems, type TodayItem } from "./store";
import { todayTestDb } from "./test-db";

const web = {
  name: "web",
  workflow: "web-deploy-prod.yml",
  paths: ["apps/web/"],
};
const worker = { name: "worker", workflow: "worker-deploy-prod.yml", paths: [] };
const merge = (number: number, mergedAt: string, app = web): Undeployed => ({
  repo: "acme/shop",
  app,
  tag: `${app.name}-prod-v2`,
  merge: { sha: `sha${number}`, number, title: `fix: change ${number}`, mergedAt },
});

/** The board after one deploy collection: two web PRs (newest collected first) and one worker. */
function board(): TodayItem[] {
  const db = todayTestDb();
  applyCollection(
    db,
    "shop:deploys",
    "shop",
    [
      merge(162, "2026-11-10T14:40:53Z"),
      merge(161, "2026-11-06T01:41:12Z"),
      merge(163, "2026-11-11T21:20:23Z", worker),
    ].map(deployToItem),
    "2026-11-18T16:00:00Z",
  );
  return listItems(db);
}

const NOW = new Date("2026-11-18T16:00:00Z");
const asItem = (item: TodayItem) => item as unknown as Item;

describe("grouped by app", () => {
  test("one group per app, oldest merge first, even an app with one PR", () => {
    const groups = appGroups(board()).map((g) => g.map((m) => m.meta?.number));
    expect(groups).toEqual([[161, 162], [163]]);
    // They're what one session works, so launch and the page find them as stacks.
    expect(prStacks(board())).toHaveLength(2);
    const items = board();
    const single = items.find((i) => i.meta?.number === 163)!;
    expect(stackOf(items, single)?.map((m) => m.id)).toEqual([single.id]);
  });

  test("each PR flags its wait, amber after 3 days; the app line sums them up", () => {
    const [webGroup] = appGroups(board().map(asItem));
    expect(flagFor(webGroup![1]!, NOW)).toMatchObject({
      tone: "amber",
      text: "not in web prod · 8d",
    });
    expect(promoteFlag(webGroup!, NOW)).toMatchObject({
      tone: "amber",
      text: "web · 2 PRs · 12d",
    });
    const ctx = { date: "2026-11-18", now: NOW, live: new Set<string>(), stackOf: () => null };
    expect(itemLane(webGroup![0]!, ctx)).toBe("actionable");
  });

  test("the Tasks tile is gone; Ready to promote headlines every PR", () => {
    const summaries = summarize(board().map(asItem), NOW);
    expect(summaries.map((s) => s.info.slug)).toEqual([
      "promises",
      "reviews",
      "prs",
      "tickets",
      "promote",
    ]);
    expect(summaries.find((s) => s.info.section === "promote")?.headline).toHaveLength(3);
    expect(summaries.find((s) => s.info.section === "my_pr")?.total).toBe(0);
  });
});

describe("Ship it", () => {
  const [webGroup] = appGroups(board());
  const project = { cwd: "/shop", worktree: { branchPrefix: "alex/" } };

  test("one session for the app, in the main checkout", () => {
    expect(stackTitle(webGroup!)).toBe("Ship web: 2 PRs waiting on its promote");
    expect(stackFolder(webGroup!, project)).toEqual({ cwd: "/shop" });
    expect(launchFolder(webGroup![0]!, project)).toEqual({ cwd: "/shop" });
    expect(planStackLaunch(webGroup!, false)).toEqual({ kind: "new", others: [] });
  });

  test("lists the PRs, checks for a waiting promote, asks before running one, never approves", () => {
    const prompt = stackPrompt(webGroup!, {});
    expect(prompt).toContain("web (acme/shop) is still on `web-prod-v2`");
    expect(prompt).toContain("board key `deploy:acme/shop#161:web`");
    expect(prompt).toContain("gh workflow run web-deploy-prod.yml -R acme/shop");
    expect(prompt).toContain("ask me on the board before running the deploy workflow");
    expect(prompt).toContain("run it only once I say go");
    expect(prompt).toContain("Never approve a promote yourself");
    expect(prompt).toContain("Stop and ask me before you do any of these");
    expect(prompt).not.toContain("CodeRabbit");
  });
});

test("the deploy check is a GitHub source on its own interval, only when configured", () => {
  const config = parseTodayConfig({
    projects: [
      {
        name: "shop",
        cwd: "/shop",
        github: { repos: ["acme/shop"], org: "acme", deploys: {} },
      },
      { name: "notes", cwd: "/nw", github: { repos: ["octo-org/notes"] } },
    ],
  });
  const run = async () => "";
  const [shop, notes] = config.projects;
  const deploys = projectSources(shop!, run).find((s) => s.name === "shop:deploys");
  expect(deploys).toMatchObject({ github: true, intervalMs: 30 * 60_000 });
  expect(shop!.github?.deploys).toEqual({ days: 60, graceHours: 24, intervalMinutes: 30 });
  expect(projectSources(notes!, run).some((s) => s.name.endsWith(":deploys"))).toBe(false);
});
