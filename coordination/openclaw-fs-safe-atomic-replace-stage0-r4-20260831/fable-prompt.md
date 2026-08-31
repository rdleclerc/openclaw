# Fable planning prompt

You are the source-backed planner for a fresh OpenClaw-only Stage 0 R4
campaign. Return a plan only. Do not edit files. Do not run tests. Do not
commit, push, deploy, restart, call providers, or use Slack.

Read these files completely:

1. `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r4-20260831/AGENTS.md`
2. `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r4-20260831/coordination/openclaw-fs-safe-atomic-replace-stage0-r4-20260831/operator-request.md`
3. `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r4-20260831/coordination/openclaw-fs-safe-atomic-replace-stage0-r4-20260831/source-packet.md`
4. The five current source files named in the source packet.
5. The exact published 0.4.1 package files from the tarball named in the source
   packet.
6. R3 `terminal-stop.md`, `installed-package-proof.md`, `green-proof.md`, and
   `frozen-plan.md` below
   `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r3-20260831/coordination/openclaw-fs-safe-atomic-replace-stage0-r3-20260831`.

The exact R4 base is
`0a1c7ad3b2fa79272a032d4f8913ef5e8e53d5ba`.

Plan from first principles. Keep the same five-file behavior boundary. The
fresh difference is package delivery. Require a normal contextual Git patch
with sufficient surrounding lines. Do not use a zero-context patch. Require
pnpm-installed bytes to equal the reviewed intended bytes before final review.

Return:

- the smallest architecture decision and non-goals;
- the exact five-file manifest;
- realistic per-file and total changed-line budgets;
- exact async and sync transformations;
- a reproducible normal-context, one-section-per-file patch procedure;
- proof-first red cases and expected failures;
- manual, intended, and pnpm-installed tree equality proof;
- focused test, patch-guard, formatting, and diff commands;
- fresh uncommitted review gates before code commits;
- the required independent plan and final review gates;
- landing, activation, native proof, rollback, cleanup, and release steps;
- stop conditions and a KISS assessment.

Use `PLAN` as the first line if the five-file scope can satisfy the contract.
Use `BLOCKED` if current source proves it cannot. Do not ask routine questions.
