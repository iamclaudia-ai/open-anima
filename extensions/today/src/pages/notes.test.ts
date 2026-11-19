import { describe, expect, test } from "bun:test";
import type { Section } from "./model";
import { NOTES, sectionNote } from "./notes";

const SECTIONS = Object.keys(NOTES) as Section[];

describe("section notes", () => {
  test("a busy page gets a busy note, a clear page a clear one", () => {
    for (const section of SECTIONS) {
      const clear = NOTES[section].clear as string[];
      expect(clear).toContain(sectionNote(section, 0, 0.5));
      expect(clear).not.toContain(sectionNote(section, 3, 0.5));
    }
  });

  test("counts only show up for 2 or more, so nothing says '1 PRs'", () => {
    for (const section of SECTIONS) {
      for (let i = 0; i < 20; i++) {
        expect(sectionNote(section, 1, i / 20)).not.toMatch(/\b1 /);
      }
      const counted = Array.from({ length: 20 }, (_, i) => sectionNote(section, 7, i / 20));
      expect(counted.some((note) => note.startsWith("7 "))).toBe(true);
    }
  });

  test("the same seed keeps the same note across re-renders", () => {
    expect(sectionNote("review", 4, 0.37)).toBe(sectionNote("review", 4, 0.37));
  });

  test("never repeats the last visit's note", () => {
    for (let i = 0; i < 20; i++) {
      const last = sectionNote("my_pr", 3, i / 20);
      expect(sectionNote("my_pr", 3, i / 20, last)).not.toBe(last);
    }
  });

  test("every seed in [0, 1) lands on a note", () => {
    for (const section of SECTIONS) {
      expect(sectionNote(section, 2, 0.999999)).toBeTruthy();
      expect(sectionNote(section, 0, 0)).toBeTruthy();
    }
  });
});
