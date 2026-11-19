import { afterEach, describe, expect, test } from "bun:test";
import { type BoardStorage, cachedBoard, forgetBoard, rememberBoard } from "./board-cache";
import type { ListResponse } from "./model";

function memoryStorage(): BoardStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function board(date: string): ListResponse {
  return { date, note: "hi", noteUpdatedAt: null, items: [], collections: {} };
}

const NOON = new Date(2026, 10, 18, 12);
const TOMORROW = new Date(2026, 10, 19, 9);

afterEach(forgetBoard);

describe("board cache", () => {
  test("starts empty", () => {
    expect(cachedBoard(NOON, memoryStorage())).toBeNull();
  });

  test("hands back the last board from memory while it is the same day", () => {
    rememberBoard(board("2026-11-18"), null);
    expect(cachedBoard(NOON, null)?.note).toBe("hi");
  });

  test("survives a fresh page load through storage", () => {
    const storage = memoryStorage();
    rememberBoard(board("2026-11-18"), storage, 0);
    forgetBoard();
    expect(cachedBoard(NOON, storage)?.date).toBe("2026-11-18");
  });

  test("never shows yesterday's board, and drops it from storage", () => {
    const storage = memoryStorage();
    rememberBoard(board("2026-11-18"), storage, 0);
    expect(cachedBoard(TOMORROW, storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  test("a burst of loads writes storage once, with the latest board", async () => {
    const storage = memoryStorage();
    let writes = 0;
    const counting = {
      ...storage,
      setItem: (k: string, v: string) => (writes++, storage.setItem(k, v)),
    };
    rememberBoard({ ...board("2026-11-18"), note: "one" }, counting, 5);
    rememberBoard({ ...board("2026-11-18"), note: "two" }, counting, 5);
    await Bun.sleep(20);
    expect(writes).toBe(1);
    expect(JSON.parse(storage.data.values().next().value!).note).toBe("two");
  });

  test("ignores storage that is unreadable or throws", () => {
    const broken: BoardStorage = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    expect(cachedBoard(NOON, broken)).toBeNull();
    expect(() => rememberBoard(board("2026-11-18"), broken, 0)).not.toThrow();
    expect(cachedBoard(NOON, broken)?.date).toBe("2026-11-18");
  });
});
