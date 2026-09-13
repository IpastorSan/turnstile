# planning/

The planning artifacts that directed the AI agents which wrote this codebase,
published here because ETHOnline 2026's AI rules require it:

> **Spec-Driven Development:** Using spec-driven workflows (e.g. OpenSpec, Kiro,
> spec-kit) is permitted. If you use one, you must include all spec files,
> prompts, and planning artifacts in your submission repository. Judges need to
> see the full picture of how you directed the AI, not just the generated
> output.

[`AI-USE.md`](../AI-USE.md) at the repo root is the disclosure itself: which
tools, which parts of the codebase they wrote, and what a human did instead.
This directory holds the inputs.

## What is here

| File | What it is |
|---|---|
| [`turnstile-v3-day1-plan.md`](./turnstile-v3-day1-plan.md) | The whole build plan, written 2026-09-04 before a line of code existed. Product, architecture, per-sponsor qualification gates, day-by-day sequencing, and pre-declared cut lines. Verbatim, wrong claims included. |

## How the plan became issues

1. **The plan was written first**, on day 1, against primary sponsor docs. Its
   §5 Step 0 says what to do with it: *"Before any code, run `/ralph-planning`
   against this document."*
2. **`/ralph-planning` broke it into ordered issues** with a mini-plan,
   acceptance criteria, files to touch and dependency relations on each. The
   per-sponsor gate lists in the plan's §4 became acceptance criteria, so a
   missed prize gate fails an issue rather than being noticed on the last day.
   Those issues are `MOV-2XX`, and every feature branch in this repo is named
   after one.
3. **§4 of the plan was committed to this repo on day 1 as
   [`CHECKLIST.md`](../CHECKLIST.md)** and then kept as the live record. Commit
   `0dd32f8`, 2026-09-04, whose subject line records it as plan §4 verbatim,
   50 binary gates.
4. **`/ralph-implement` ran the loop.** One issue, one fresh-context agent, one
   git worktree, one branch, verified and merged with `--no-ff`. The mandatory
   version of that loop is in [`CLAUDE.md`](../CLAUDE.md) §7, and
   [`scripts/wt.sh`](../scripts/wt.sh) is the script that enforces it.

## How to read the evidence

The plan is the input. The output is legible in three places:

- **`git log --graph --first-parent dev`** and the 96 pushed
  `feat/…`, `docs/…` and `fix/…` branches on the remote. One branch per issue,
  never deleted after merging, `--no-ff` so the feature boundary survives.
  Commit bodies are written to be read: they say what was checked, what was not,
  and what the change disproved.
- **[`CHECKLIST.md`](../CHECKLIST.md)**, whose second half is a per-issue
  evidence block: MOV-215, MOV-216, MOV-217, MOV-218, MOV-219, MOV-220,
  MOV-221, MOV-222, MOV-225, MOV-226 and MOV-230 each have a dated section with
  transaction hashes, terminal output and an explicit list of what was not
  exercised.
- **[`CORRECTIONS.md`](../CORRECTIONS.md)**, the audit trail of claims that were
  written into this repo, turned out to be false, and were withdrawn with a
  dated note rather than quietly edited away.

## What is deliberately not here

- **The per-issue mini-plans themselves.** They were created in Linear by
  `/ralph-planning` and stayed there. What survives in this repo is each issue's
  acceptance criteria (restated in `CHECKLIST.md`) and each issue's commits.
  Stating that plainly is better than implying the repo holds everything.
- **`/ralph-planning` and `/ralph-implement`.** They are personal Claude Code
  skills in the operator's own configuration, not project files, and they are
  generic: they know nothing about Turnstile. What they did for this project is
  described above and in [`AI-USE.md`](../AI-USE.md).
- **Video scripts, prize-money research and day-by-day status notes** from the
  private research repo this plan came from. None of them directed the code.
- **Nothing was withheld as a secret.** The day-1 plan discusses sponsor prize
  strategy, which sponsors were worth the most and which were pre-declared as
  cut lines. That was competitively sensitive during the event and is published
  unedited now that it is over. There are no credentials, private keys or API
  keys in it, and there never were: this repo's secrets live in `.env`, which is
  gitignored.
