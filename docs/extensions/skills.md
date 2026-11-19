# Skills extension

Claude Code loads skills (a folder with a `SKILL.md`) from `~/.claude/skills` and from each project's
`.claude/skills`. The skills extension manages those folders without owning them. Your own skills live in one git
repo (the "skills repo", `repoPath`), and the extension places them by symlink, globally or into one project. Skills
other tools installed, and the claude.ai account skills Claude Code syncs into `~/.claude/skills/synced`, are listed
but never moved or deleted; you hide those with Claude Code's own `skillOverrides` setting instead. The extension
also contributes local CLI commands, `anima skills run|task|commands|help`, which run a skill's scripts on the
caller's machine and can queue long ones on the scheduler. It calls `session.list_workspaces` (to know which project
folders to scan), and the CLI calls `scheduler.add_task`, `scheduler.get_history`, `scheduler.list_tasks` and
`scheduler.cancel_task`. It emits and listens to no events.

## Methods

All methods run on the default serial write lane (none declares `execution`).

| Method                  | Purpose                                                                                                              | Params                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `skills.list_skills`    | Inventory: every skill with `source`, `placements`, `visibility`, plus `problems` and the repo's uncommitted changes | none                                                                                              |
| `skills.link`           | Symlink a repo skill into `~/.claude/skills`, or into `<project>/.claude/skills`                                     | `skill` (folder name in the repo), `project` (absolute; omit for global)                          |
| `skills.remove_link`    | Remove such a symlink (only links that point into the repo)                                                          | `skill`, `project`                                                                                |
| `skills.set_visibility` | Set the skill's entry in `skillOverrides` in `~/.claude/settings.json`                                               | `skill` (frontmatter `name`), `visibility`: `on` \| `name-only` \| `user-invocable-only` \| `off` |
| `skills.health_check`   | Counts: skills, placed, problems, repo changes. `degraded` when there are problems or uncommitted repo changes       | none                                                                                              |

A skill record (`SkillRecord` in `src/inventory.ts`): `id` (folder name), `name` (frontmatter `name`, else the folder
name), `description`, `source` (`repo` \| `third-party` \| `synced` \| `project`), `sourcePath` (real folder),
`placements` (`{ scope: "global" | "project", project?, path, kind: "symlink" | "directory" }`), `visibility`.

## Local CLI commands

Defined in `src/cli.ts` and run by the `anima` CLI itself, not the gateway (so they work with the gateway down,
except for `--task` and `task`). From a checkout, use `bun run cli skills ...` in place of `anima skills ...`.

| Command                                                              | What it does                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `anima skills commands [skill-id]`                                   | List skills that have runnable commands, or one skill's commands                                     |
| `anima skills help <skill-id> <command>`                             | Script or binary, runtime, timeout, required env vars, declared args                                 |
| `anima skills run <skill-id> <command> [args...] [--task \| --sync]` | Run a command inline (stdio inherited, exit code passed through), or queue it on the scheduler       |
| `anima skills task <task-id> [--watch \| --cancel]`                  | Status of a queued run as JSON; `--watch` polls every 2 s until it ends; `--cancel` deletes the task |

A skill's commands come from two places (`src/cli/resolve.ts`):

1. `skill.json` in the skill folder, `commands.<name>` with either `script` (a file in the skill folder) or `command`
   (a binary on `PATH`), plus optional `runtime`, `longRunning`, `description`, `args`, `env` (required variables,
   checked before the run) and `timeoutMs` (default 600000). Types are in `src/cli/types.ts`.
2. By convention, without `skill.json`: `scripts/<command>` with `.js`, `.ts`, `.mjs`, `.mts`, `.py`, `.sh` or no
   extension. The runtime follows the extension (`.ts`/`.mts` with `bun`, `.js`/`.mjs` with `node`, `.py` with
   `python3`, `.sh` with `bash`), or the shebang for a file without one, else the file is executed directly.

Inline runs (`src/cli/run.ts`) start in the skill folder with `SKILL_DIR`, `SKILL_ID` and `SKILL_COMMAND` set; a
timeout exits 124. `--task`, or `longRunning: true` without `--sync`, instead calls `scheduler.add_task` with a
`once` task named `skill:<id>:<command>`: an `exec` action with the same command, folder, env and timeout, tagged
`skill` and `skill:<id>`. The scheduler adds `ANIMA_TASK_ID` and `ANIMA_EXECUTION_ID`, so the script can report
progress with `scheduler.update_progress`.

## Web pages

None.

## Config

`extensions.skills.config` in `~/.anima/anima.json`:

| Key        | Default | Meaning                                                                                                              |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `repoPath` | unset   | Your skills repo: one folder per skill, each with a `SKILL.md`. `~` is expanded. Needed by `link` and `remove_link`. |

`anima.example.json` shows it commented out (`"~/skills"`).

## Placing your skills in ~/.claude/skills

1. Keep your skills in one folder, ideally a git repo: `~/skills/<skill-id>/SKILL.md`, plus any `scripts/` and
   `skill.json`.
2. Set `"repoPath": "~/skills"` under `extensions.skills.config`, then restart the gateway so the extension gets the new
   config (see the gotchas).
3. Link a skill everywhere, or into one project:

   ```bash
   bun run cli skills link --skill my-skill
   # ~/.claude/skills/my-skill -> ~/skills/my-skill

   bun run cli skills link --skill my-skill --project /abs/path/to/project
   # /abs/path/to/project/.claude/skills/my-skill -> ~/skills/my-skill
   # and "/.claude/skills/my-skill" is added to that repo's .git/info/exclude
   ```

4. Check with `bun run cli skills list_skills`; undo with `skills remove_link` (same params).

New Claude Code sessions see the skill, and `anima skills commands my-skill` lists its commands. You can
also make the symlink by hand (`ln -s ~/skills/my-skill ~/.claude/skills/my-skill`); the inventory treats a link into
`repoPath` the same way whoever made it.

## How it works

The extension is stateless (`src/index.ts`). Every call rebuilds the inventory (`buildInventory` in
`src/inventory.ts`) from the filesystem:

1. Every folder in the repo with a `SKILL.md` is a `repo` skill, placed or not.
2. Each entry of `~/.claude/skills` and of `<project>/.claude/skills` is a placement. Symlinks are resolved; the
   source is `repo` if the real folder is inside the repo, else `third-party` (global) or `project`. `synced/` is
   read two levels deep as `synced` skills. Hidden entries are skipped.
3. Problems: broken symlinks, entries without a `SKILL.md`, two global skills with one `name`, and a project skill
   that shadows a global one of the same name.

Projects are the workspaces the session extension knows (`session.list_workspaces`), resolved to real paths, with
anything under `/tmp/` or `/private/tmp/` left out. Names and descriptions come from the `SKILL.md` frontmatter, parsed
as YAML with a line-by-line fallback for frontmatter Claude Code accepts but YAML doesn't (an unquoted `: ` in a
description). Visibility comes from `skillOverrides`.

`link` (`src/placement.ts`) checks the id (`[A-Za-z0-9][A-Za-z0-9._-]*`), that the repo folder has a `SKILL.md`, and
creates the `.claude/skills` folder if needed. If that folder is itself a symlink (to a tracked `.agents/skills`, say),
the link goes in the real folder. It refuses to replace anything that isn't already its own link. In a git repo the
link's path is added to `.git/info/exclude` under a `# anima skills: ...` header (found with `git rev-parse
--git-path`, so worktrees work), so it never shows in `git status`. `remove_link` only removes a symlink that points
into the repo (or is broken), and takes its exclude line out again.

`set_visibility` (`src/settings.ts`) re-reads `settings.json` on every write, changes only that one key (`on` removes
the entry), and writes atomically (temp file and rename, following a symlinked settings file and keeping its mode).
It refuses to touch a file that isn't valid JSON, and refuses `synced` skills, because how Claude Code keys those
in `skillOverrides` is unverified.

Nothing is stored in the database or the data folder.

## Gotchas

- **It works on the real `~/.claude`, whatever `ANIMA_HOME` says.** The extension and the CLI use the OS home folder,
  because that is where Claude Code reads skills. A second, isolated instance on the same machine sees and changes the
  same skills and settings as the first.
- **Without `repoPath`, your own symlinked skills show as `third-party`.** The inventory can't tell them apart, and
  `link`/`remove_link` throw `skills.repoPath is not configured`.
- **Config changes need a gateway restart.** `gateway.restart_extension` respawns the extension with the config it was
  first given; the gateway's config watcher only starts and stops extensions. Restart the gateway (or set the
  extension `enabled: false`, save, then back to `true`) after changing `repoPath`.
- **`anima skills run` resolves skills on the caller's machine, only under `~/.claude/skills/<skill-id>`.** Project
  skills are not runnable this way. With `--task`, the paths resolved locally are handed to the scheduler, which runs
  them on the gateway's machine, so `--task` only works when both are the same machine.
- **Visibility is keyed by `name`, placement by folder.** `set_visibility --skill` wants the frontmatter `name`;
  `link --skill` wants the folder name. They usually match, but not always.
- **`Degraded` on a fresh install usually means your own `~/.claude/skills`.** The inventory reads the real folder,
  so a broken symlink, a folder without a `SKILL.md` or two global skills with one name there mark the card
  degraded on `/control`, before you've placed anything with this extension. The card shows only the count;
  `anima skills list_skills` lists each problem with its path (`problems`).
- **`health_check` does real work.** It rebuilds the whole inventory and runs `git status` in the repo, and the
  `/control` dashboard calls it every 5 seconds while open.
- **`anima skills task` reports the first 4 KB of output** although it prints "last 4KB": the scheduler stores the
  start of the output.

## Code map

- `src/index.ts`: methods; resolves `repoPath`; asks the session extension for projects.
- `src/inventory.ts`: inventory, frontmatter parsing, problems, `projectRootsFromWorkspaces`.
- `src/placement.ts`: `linkSkill`, `removeSkillLink`, `.git/info/exclude` upkeep.
- `src/settings.ts`: `skillOverrides` reads and atomic writes.
- `src/cli.ts`: the local command table.
- `src/cli/resolve.ts`: skill and command resolution, runtime detection, `listSkills`.
- `src/cli/run.ts`: inline runs and `--task` submission.
- `src/cli/task.ts`: task status, watch, cancel.
- `src/cli/list.ts`, `src/cli/help.ts`: `commands` and `help` output.
- `src/cli/types.ts`: `skill.json` types.
