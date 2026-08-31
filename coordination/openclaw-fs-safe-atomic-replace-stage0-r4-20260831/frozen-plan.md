# Frozen R4 plan

Status: ready for independent plan and KISS review. Product and test files are
unchanged.

## Decision

Keep the approved R3 safety behavior and the same five repository files. Change
only the package-patch encoding. Generate one normal three-line-context Git
patch from the exact published package tree to the exact intended package
tree. Pnpm-installed package bytes become the final authority before review.

The measured contextual patch is 392 patch lines. Relative to the base package
patch, it adds 320 repository lines and removes none. The patch-owner cap is
340 changed lines. The five-file campaign cap is 1,200 changed lines.

## Implementation phases

1. Add only the two focused test owners. Run all 62 tests against the exact
   base package. Require 30 failures and 32 passes in the seven named failure
   groups from R3.
2. Run fresh uncommitted repository review on the test-only diff. Resolve all
   accepted findings. Commit only the reviewed red diff.
3. Extract the exact published tarball into a temporary package Git repository.
   Commit the original tree as the baseline. Apply the current base patch with
   zero fuzz. Apply the reviewed final safety and documentation changes.
4. Require the exact six new package blobs and intended replacement SHA-256
   recorded in `fable-raw-plan.md`.
5. Generate `git diff --full-index --binary --no-ext-diff -- .` with normal
   three-line context. Do not pass `-U0`. Require six sections, six unique
   package paths, real context in every hunk, the measured 392-line form, and
   SHA-256
   `9cb2b91283ac7a5b6ae3d1e4d28375af94e2628be47b14f9ea32d120cf227c42`.
6. Apply that generated patch with zero fuzz to a fresh package extraction.
   Require the complete intended and manual package trees to match by a
   deterministic path, type, mode, size, link-target, and SHA-256 manifest and
   by `diff -r`.
7. Replace the repository package patch. Bind its new SHA-256 at exactly three
   lockfile locations. Update only the existing package-patch guard comment.
8. Run all 62 focused tests, five patch-guard tests, the executable guard,
   formatting, diff validation, path validation, and budget validation against
   the exact uncommitted five-file diff.
9. Run fresh uncommitted repository review. Resolve all accepted findings. If
   any product or test file changes, repeat the green proof and review. Commit
   only the reviewed exact diff.
10. Create a clean isolated checkout of the exact product commit. Use bundled
    Node 24.19.0 and pnpm 11.19.0. Run
    `pnpm install --frozen-lockfile --offline` with the bundled Node directory
    first in `PATH`. Require zero downloads.
11. Require complete equality among the intended, manual, and pnpm-installed
    package trees. Require package version 0.4.1 and the intended replacement
    SHA-256. Run the 62 focused tests, five patch-guard tests, executable guard,
    formatter check, and diff check from the installed checkout.
12. Freeze the exact candidate and receipts only after installed equality
    passes. Run fresh independent exact-diff, adversarial, and acceptance
    reviews. All must return `CONTINUE`.

## Exact safety behavior

- Delete the destructive async and sync permission-copy fallback and its
  private helpers.
- Keep bounded `EBUSY` rename retry. Propagate terminal rename errors unchanged.
- Keep the public fallback option and result type compatible. The option becomes
  inert.
- In async and sync replacement, finish exclusive create and write before the
  temp path becomes owned or registered for process-exit cleanup.
- Keep owned-temp cleanup. Put conditional unregistration in a guaranteed
  `finally` so cleanup errors cannot retain a stale registration.
- After successful rename, unregister immediately before chmod or
  parent-directory synchronization.
- Correct only the atomic-replace fallback claims in package `README.md`,
  `docs/atomic.md`, and `docs/index.md`. Do not change the separate move-helper
  contract.

## Review rule

R4 can use one consolidated correction and one review rerun across the full
campaign. A second review bounce is terminal. Every required independent review
uses a fresh `gpt-5.6-sol` context at `ultra` reasoning effort. Product edits
start only after the plan review returns `CONTINUE`.

## Landing and activation

After all final reviews approve:

1. Verify remote `main` still equals the reviewed base. Stop if it moved.
2. Acquire the canonical OpenClaw landing window. Land the exact reviewed
   five-file candidate with a non-force update.
3. Build an immutable OpenClaw release from the exact landed commit. Run the
   frozen offline install and installed-package identity proof in that release.
4. Capture the exact prior active release, process, listener, health, and
   rollback inputs.
5. Require zero durable queued, running, and active tasks. Coordinate the shared
   runtime window. Activate the exact release and perform one safe restart.
6. Prove the sole listener, health, readiness, exact OpenClaw commit, package
   version, installed replacement SHA-256, and focused native tests.
7. Do not post to Slack. This package primitive has no direct Slack acceptance
   contract.
8. Clean the canonical landing lane and release all source and shared surfaces.

Rollback reactivates the captured prior immutable release, performs one safe
restart, and proves the prior listener and health. A source rollback reverts the
landed commit and restores the prior package patch hash at all three lockfile
locations.

## Stop conditions

Stop and preserve the lane if any of these conditions occur:

- a changed file leaves the manifest;
- a file or total budget fails;
- the patch section set, context shape, blob pair, measured hash, or line count
  differs without a reviewed cause;
- the red split differs without an explained source cause;
- intended, manual, and installed package trees differ;
- the offline install downloads a package;
- a focused test, guard, formatter, or diff check fails;
- a protected evidence worktree changes;
- a required review does not return `CONTINUE` within the one-correction rule;
- remote `main` moves before landing;
- runtime ownership, drain, activation, health, or native proof becomes unsafe.

## KISS assessment

R4 changes the patch context and the budget only. It uses the existing pnpm
patch owner and tests. It adds no runtime code or state owner. Installed-byte
equality directly prevents the R3 delivery failure.
