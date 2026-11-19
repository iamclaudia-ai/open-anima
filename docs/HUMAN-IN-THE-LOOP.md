# Human in the loop

Open Anima's defaults keep a person in charge of every step that leaves the machine or can't be taken back. The agent
does the work (reads, edits, commits, runs tests, drafts the text) and then **stops, shows you what it's about to do,
and waits for your go**. This page lists where those checkpoints are, which ones code enforces and which ones are
instructions the agent follows, and how to tighten or loosen them.

## Why

An agent that can push, merge, post and deploy on its own is fast until the day it does the wrong thing in public.
Most teams aren't ready to hand that over, and they shouldn't have to in order to get value from an agent: preparing
the work is most of the effort, and approving it takes you a minute.

Trust is earned per team and per kind of task. The people who built Anima started exactly here and loosened specific
gates over time, deliberately, as they learned how their agent handled each one. Treat these defaults as a starting
point, not a ceiling, and change them on purpose rather than by drift.

## The gates

The agent asks first before it:

| Gate     | Covers                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------- |
| `push`   | pushing a branch, opening or updating a pull request                                                     |
| `merge`  | approving or merging a pull request                                                                      |
| `post`   | anything other people see: a review, a PR comment or reply, resolving a thread, a chat message, an email |
| `deploy` | deploying, promoting, running a release workflow                                                         |

Plus, from the persona: deleting anything that can't be put back.

## Where they live

### 1. The persona (every session)

`personas/lumen.md` has a section, "Your human decides what leaves the machine", that lists these steps and tells the
agent to prepare, explain and wait. Every Claude session loads the persona, so this is the gate that covers sessions
you start yourself from the chat or the CLI. If you write your own persona, keep a section like it
([PERSONAS.md](PERSONAS.md)).

### 2. The Today board's prompts

Every prompt the board sends a session (launch, a stack of PRs, the review queue, follow-ups, promote) ends with a
gate paragraph built by `gateLine()` in `extensions/today/src/approvals.ts` from the `approvals` config:

```jsonc
// ~/.anima/anima.json → extensions.today.config
"approvals": { "push": true, "merge": true, "post": true, "deploy": true }   // the default
```

The paragraph tells the session to get the step ready (the commits, the draft text, the exact command), say what it's
about to do and why, ask you with `anima today ask --key <item key> --question "…"` (the prompt
fills in the key), and wait. `today.ask` shows the question on the
board under the item, marks the session `blocked`, and if you haven't answered within 10 minutes sends it through
`notify.send` (see [extensions/notify.md](extensions/notify.md): the default delivery only writes a log line, so pick a
real one). Your next message to that session answers it.

Turning a gate off (`"post": false`) removes that step from the paragraph. `post` and `deploy` also switch the review
and promote prompts between "draft it" and "do it".

### 3. Review sessions draft, they don't post

A review launched from the board tells the session to draft the review (verdict, summary, each inline comment with
its file and line), not post it. The review queue writes each draft to `tmp/reviews/<number>.md` in the repo and
stops. You read it, edit it, and post it yourself (or tell the session "post it"). The `running-review-sessions`
skill in the companion open-skills collection (<https://github.com/iamclaudia-ai/open-skills>) follows the same
rule.

### 4. Nudges are copied, not sent

`today.nudge` (the board's "nudge" button on your PR that's waiting for review) only returns a drafted message. The
page copies it to your clipboard on a second click; you paste it where your team asks for reviews.

### 5. The extension code itself

Nothing in Open Anima's extensions pushes, merges, posts, sends mail or deploys on its own. The bundled Today tools
(`extensions/today/tools/`) only read from GitHub. The board's own writes are local: starting sessions and prompting
them (including automatic follow-ups), setting a session's status, snoozing a Linear issue when you click snooze, and
notifications to you.

## What is enforced, and what is only asked

Be clear-eyed about this: **gates 1 and 2 are instructions, not locks.** Sessions the board starts run under the
`yolo` permission profile by default (Claude Code's bypass-permissions mode), and so do sessions you create from the
chat. A session that ignores its prompt can run `git push` or `gh pr merge`. In practice a well-instructed agent asks,
but "in practice" isn't a guarantee.

To make a gate hard, add a session profile that denies the commands, and run the board's sessions under it:

```jsonc
// ~/.anima/anima.json
"agentHost": {
  "sessionProfiles": {
    "gated": {
      "permissionMode": "bypassPermissions",
      "disallowedTools": [
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
        "Bash(gh pr review:*)",
        "Bash(gh pr comment:*)",
        "Bash(gh workflow run:*)"
      ]
    }
  }
},
"extensions": {
  "today": { "config": { "sessionProfile": "gated", ... } }
}
```

Claude Code honors deny rules even in bypass mode (we checked: `--dangerously-skip-permissions --disallowedTools
"Bash(git push:*)"` blocks the push). The session then prepares everything and hands you the exact command to run.
Profiles are described in `packages/agent-host/src/profiles.ts`; `session.create_session --profile gated` uses one for
a session you start yourself.

Limits worth knowing:

- **Prefix rules are a guard rail, not a sandbox.** `Bash(git push:*)` doesn't catch `git -C repo push` or a script
  that pushes. Pair it with branch protection, required reviews, and a deploy environment that needs approval. Those
  hold no matter who runs the command.
- **A PreToolUse hook that rewrites Bash commands defeats deny rules**, because the rule is matched against the
  rewritten command. Anima's agent-host installs no such hook, but your own `~/.claude/settings.json` might.
- **A session keeps the profile it was created with.** Changing `sessionProfile` affects sessions the board starts
  from then on.

## Loosening a gate

When a gate keeps asking about something you always approve, that's the signal to consider loosening it, for that one
step. Set its `approvals` key to `false`, update your persona's list to match, and watch the next few runs. Write the
decision down where your team will see it (your persona or your `CLAUDE.md`), so the agent and your colleagues know the
rule changed and why.

Things to keep gated longest: anything posted under your name, merges to shared branches, and deploys.
