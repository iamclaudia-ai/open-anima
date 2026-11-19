import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSkill, removeSkillLink } from "./placement";
import { readSkillOverrides, setSkillVisibility } from "./settings";

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function skill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: x\ndescription: "d"\n---\n`);
}

const status = (repo: string) => sh(repo, "status", "--porcelain").trim();
const exclude = (repo: string) => readFileSync(join(repo, ".git", "info", "exclude"), "utf8");

describe("linkSkill / removeSkillLink", () => {
  let root: string;
  let home: string;
  let repo: string;
  let plain: string;
  let monorepo: string;
  let worktree: string;
  let foreign: string;
  const paths = () => ({ home, repoPath: repo });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "anima-skills-place-")));
    home = join(root, "home");
    repo = join(root, "skills-repo");
    plain = join(root, "plain");
    monorepo = join(root, "monorepo");
    worktree = join(root, "plain-wt");
    foreign = join(root, "elsewhere", "foreign");
    mkdirSync(home, { recursive: true });
    for (const id of ["alpha", "beta", "team-skill"]) skill(join(repo, id));
    skill(foreign);

    // A plain repo with an existing local exclude entry we must preserve.
    mkdirSync(plain);
    sh(plain, "init", "-q");
    writeFileSync(join(plain, "README.md"), "hi\n");
    sh(plain, "add", ".");
    sh(plain, "commit", "-qm", "init");
    writeFileSync(join(plain, ".git", "info", "exclude"), "# mine\n*.log\n");

    // A common monorepo layout: .claude/skills is a tracked symlink to a tracked .agents/skills.
    mkdirSync(monorepo);
    sh(monorepo, "init", "-q");
    skill(join(monorepo, ".agents", "skills", "team-skill"));
    mkdirSync(join(monorepo, ".claude"));
    symlinkSync("../.agents/skills", join(monorepo, ".claude", "skills"));
    sh(monorepo, "add", ".");
    sh(monorepo, "commit", "-qm", "team skills");

    sh(plain, "worktree", "add", "-q", worktree);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("links globally, and re-linking is a no-op", () => {
    const first = linkSkill(paths(), { skill: "alpha" });
    expect(first).toEqual({
      path: join(home, ".claude", "skills", "alpha"),
      created: true,
      excluded: null,
    });
    expect(readlinkSync(first.path)).toBe(join(repo, "alpha"));
    expect(linkSkill(paths(), { skill: "alpha" }).created).toBe(false);
  });

  it("links into a project and hides it in the local exclude file", () => {
    const result = linkSkill(paths(), { skill: "alpha", project: plain });
    expect(result.excluded).toBe("/.claude/skills/alpha");
    expect(exclude(plain)).toBe(
      "# mine\n*.log\n\n# anima skills: local skill links (managed by the skills extension)\n/.claude/skills/alpha\n",
    );
    expect(status(plain)).toBe("");
  });

  it("follows a symlinked .claude/skills into the real directory (a monorepo's layout)", () => {
    const result = linkSkill(paths(), { skill: "beta", project: monorepo });
    expect(result.path).toBe(join(monorepo, ".agents", "skills", "beta"));
    expect(result.excluded).toBe("/.agents/skills/beta");
    expect(lstatSync(join(monorepo, ".claude", "skills")).isSymbolicLink()).toBe(true);
    expect(status(monorepo)).toBe("");
  });

  it("never replaces a skill it does not own", () => {
    expect(() => linkSkill(paths(), { skill: "team-skill", project: monorepo })).toThrow(
      "refusing to replace it",
    );
    expect(lstatSync(join(monorepo, ".agents", "skills", "team-skill")).isDirectory()).toBe(true);
  });

  it("rejects bad ids, non-repo skills, and relative projects", () => {
    expect(() => linkSkill(paths(), { skill: "../alpha" })).toThrow("Invalid skill id");
    expect(() => linkSkill(paths(), { skill: "nope" })).toThrow("not a skill in the skills repo");
    expect(() => linkSkill(paths(), { skill: "alpha", project: "relative/dir" })).toThrow(
      "absolute path",
    );
  });

  it("links into a worktree via the shared exclude file", () => {
    const result = linkSkill(paths(), { skill: "beta", project: worktree });
    expect(result.excluded).toBe("/.claude/skills/beta");
    expect(status(worktree)).toBe("");
  });

  it("removes our links and tidies the exclude file", () => {
    removeSkillLink(paths(), { skill: "beta", project: worktree });
    const result = removeSkillLink(paths(), { skill: "alpha", project: plain });
    expect(result.unexcluded).toBe("/.claude/skills/alpha");
    expect(existsSync(join(plain, ".claude", "skills", "alpha"))).toBe(false);
    // Our header goes once nothing is left under it; the user's lines stay.
    expect(exclude(plain)).toBe("# mine\n*.log\n");
    expect(status(plain)).toBe("");
  });

  it("refuses to remove real directories and links that leave the repo", () => {
    expect(() => removeSkillLink(paths(), { skill: "team-skill", project: monorepo })).toThrow(
      "real directory",
    );
    symlinkSync(foreign, join(home, ".claude", "skills", "foreign"));
    expect(() => removeSkillLink(paths(), { skill: "foreign" })).toThrow(
      "links outside the skills repo",
    );
    expect(existsSync(join(home, ".claude", "skills", "foreign"))).toBe(true);
  });
});

describe("setSkillVisibility", () => {
  let dir: string;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "anima-skills-settings-")));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes only skillOverrides and removes entries set back to on", () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, `${JSON.stringify({ model: "x", hooks: { a: 1 } }, null, 2)}\n`);

    expect(setSkillVisibility(path, "example-skill", "off")).toEqual({
      name: "example-skill",
      previous: "on",
      visibility: "off",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      model: "x",
      hooks: { a: 1 },
      skillOverrides: { "example-skill": "off" },
    });

    setSkillVisibility(path, "example-skill", "on");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "x", hooks: { a: 1 } });
    expect(readSkillOverrides(path)).toEqual({});
  });

  it("refuses to touch a file it cannot parse", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => setSkillVisibility(path, "example-skill", "off")).toThrow("not valid JSON");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("writes through a symlinked settings file and keeps its mode", () => {
    const real = join(dir, "shared-settings.json");
    const link = join(dir, "linked-settings.json");
    writeFileSync(real, "{}\n");
    chmodSync(real, 0o600);
    symlinkSync(real, link);

    setSkillVisibility(link, "example-skill", "name-only");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({
      skillOverrides: { "example-skill": "name-only" },
    });
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });
});
