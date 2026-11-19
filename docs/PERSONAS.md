# Personas

A persona is a markdown file that tells the agent who it is and how to work with you: its name, its voice, what it
cares about, and the rules it keeps. Every Claude session Anima starts loads the same persona. Open Anima ships one,
**Lumen** (`personas/lumen.md`), a general-purpose collaborator. Write your own and point the config at it.

## Choosing the persona

`agentHost.persona` in `~/.anima/anima.json`:

| Value                        | Meaning                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| unset                        | `"lumen"`                                                                             |
| a name, e.g. `"ada"`         | `~/.anima/personas/ada.md` if it exists, else the repo's `personas/ada.md`            |
| a path, e.g. `"~/me/ada.md"` | that file (anything containing `/` or ending in `.md` counts as a path; `~/` expands) |
| `"none"` or `""`             | no persona: just Claude Code's own system prompt                                      |

`~/.anima` here is `$ANIMA_HOME/.anima`, the folder that holds `anima.json`. A name or path that resolves to nothing
is logged as a warning in `agent-host.log` and the session starts without a persona, so a typo never stops sessions
from starting. Code: `packages/agent-host/src/persona.ts`.

The persona is read when agent-host starts. After changing the setting or the file, restart agent-host
(`bun run cli watchdog restart agent-host`, or stop and start it), then close running sessions
(`bun run cli session close_session --sessionId <id>`) so their next prompt relaunches them with the new prompt: a
running Claude Code process keeps the system prompt it launched with.

## How it reaches the model

What happens depends on the runtime (`agentHost.claudeRuntime`):

- **CLI runtime** (`"cli"`, what `anima.example.json` uses): agent-host launches the real `claude` CLI. With
  `agentHost.personaMode: "append"` (the default) the persona goes in with `--append-system-prompt-file`, **after**
  Claude Code's own system prompt, which keeps all of Claude Code's tool guidance. With `"replace"` it goes in with
  `--system-prompt-file` and Claude Code's prompt is gone, so the persona has to carry everything the agent needs to
  know about using its tools well. Start with `append`. Per-session context (the current date and time, and the
  memory block when the memory extension is on) is always appended separately, in both modes. Code:
  `claudeCommand` in `packages/agent-host/src/providers/cli/session.ts`.
- **SDK runtime** (`"sdk"`, also what you get if `claudeRuntime` is unset): sessions run through the Claude Agent SDK
  and the system prompt is a plain string, the persona first, then the CLAUDE.md files. `personaMode` doesn't apply.
  Code: `packages/agent-host/src/providers/anthropic/sdk-session.ts`.

**Your CLAUDE.md files still load.** The persona is not the whole prompt. Claude Code also loads its usual memory
files: your user-level `~/.claude/CLAUDE.md`, the project's `CLAUDE.md` chain, and any `.claude/` settings. If your
global `CLAUDE.md` holds rules from your own setup, the agent will follow them in Anima sessions too, and may quote
them. That's a feature (one place for your standing rules), but it surprises people: when the agent says something
the persona never told it, look there first.

Codex sessions (`agent: "codex"`) don't use the persona.

## Writing your own

Copy Lumen and change it:

```bash
mkdir -p ~/.anima/personas
cp personas/lumen.md ~/.anima/personas/ada.md
# edit it, then in ~/.anima/anima.json:  "agentHost": { "persona": "ada", ... }
```

What earns its place in a persona:

- **Who it is.** A name and a few lines of character. The agent you talk to every day should feel like someone, and
  a name makes sessions, notes and notifications read naturally.
- **How it talks to you.** Tone, length, how much it explains, whether it asks or acts.
- **The gates.** What it must never do without your go-ahead. Lumen's "Your human decides what leaves the machine"
  section is the starting point: opening PRs, merging, posting, deploying. Keep a section like it. The Today board's
  prompts repeat these gates, but the persona is what every session sees. See [HUMAN-IN-THE-LOOP.md](HUMAN-IN-THE-LOOP.md).
- **How it works with Anima.** Lumen tells the agent it has persistent sessions, memory, a scheduler, notifications and
  the Today board, and how to hand work off (`anima session handoff`) instead of letting a long context compact.
  Keep what you use.

What doesn't belong: project-specific instructions (those go in the project's `CLAUDE.md`), secrets of any kind, and
long tool manuals (skills do that better, loaded only when needed; see [extensions/skills.md](extensions/skills.md)).

Grow it over time. The persona is the one file every session reads, so when you catch yourself correcting the same
behavior twice, that correction probably belongs here (or in your `CLAUDE.md`, if it's about how you work rather than
who the agent is).

## The Scribe

The memory extension's summarizer is an ordinary session under the `scribe` profile, so it loads the persona like
any other. Its job instructions come on top, as its first prompt (`extensions/memory/src/prompts/scribe-system.md`).
See [extensions/memory.md](extensions/memory.md).
