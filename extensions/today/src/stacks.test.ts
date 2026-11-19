import { describe, expect, test } from "bun:test";
import { prStacks, reviewStackOf, stackOf } from "./stacks";

let nextId = 1;
function pr(number: number, parent: number | null, repo = "acme/shop", status = "open") {
  return { id: nextId++, section: "my_pr", status, meta: { repo, number, parent } };
}
const numbers = (stack: Array<{ meta: Record<string, unknown> | null }>) =>
  stack.map((member) => member.meta?.number);

describe("prStacks", () => {
  test("groups PRs by their parent chain, bottom first, and leaves lone PRs out", () => {
    const items = [pr(12, 11), pr(30, null), pr(10, null), pr(11, 10), pr(21, 20), pr(20, null)];
    expect(prStacks(items).map(numbers)).toEqual([
      [10, 11, 12],
      [20, 21],
    ]);
  });

  test("two PRs on the same parent share its stack, by number", () => {
    expect(prStacks([pr(3, 1), pr(2, 1), pr(1, null)]).map(numbers)).toEqual([[1, 2, 3]]);
  });

  test("a parent that isn't on the board, another repo, a ticket or a done PR breaks the chain", () => {
    const items = [
      pr(11, 10, "acme/other"),
      pr(10, null),
      pr(41, 40),
      pr(51, 50),
      pr(50, null, "acme/shop", "done"),
      {
        id: nextId++,
        section: "ticket",
        status: "open",
        meta: { repo: "acme/shop", number: 10 },
      },
    ];
    expect(prStacks(items)).toEqual([]);
  });

  test("reviews group by the review queue's stack, in its order, even with a PR between them off the board", () => {
    const stack = [80, 81, 82, 83].map((number) => ({
      number,
      title: `Part ${number}`,
      url: `u/${number}`,
      inQueue: number !== 81,
    }));
    const review = (number: number) => ({
      id: nextId++,
      section: "review",
      status: "open",
      meta: { repo: "acme/shop", number, parent: number - 1, stack },
    });
    const lone = {
      id: nextId++,
      section: "review",
      status: "open",
      meta: { repo: "acme/shop", number: 90, parent: null, stack: null },
    };
    const groups = prStacks([review(83), lone, review(80), review(82)]);
    expect(groups.map(numbers)).toEqual([[80, 82, 83]]);
    expect(reviewStackOf(review(80))?.map((pr) => pr.number)).toEqual([80, 81, 82, 83]);
    expect(reviewStackOf(lone)).toBeNull();
  });

  test("stackOf finds an item's stack, or null", () => {
    const bottom = pr(10, null);
    const top = pr(11, 10);
    const alone = pr(12, null);
    expect(stackOf([top, bottom, alone], top)?.map((m) => m.id)).toEqual([bottom.id, top.id]);
    expect(stackOf([top, bottom, alone], alone)).toBeNull();
  });
});
