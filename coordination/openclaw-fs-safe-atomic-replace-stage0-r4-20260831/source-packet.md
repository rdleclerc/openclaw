# R4 source packet

## Source identity

- Worktree:
  `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r4-20260831`.
- Branch: `codex/openclaw-fs-safe-atomic-replace-stage0-r4-20260831`.
- OpenClaw `origin/main` and worktree base:
  `0a1c7ad3b2fa79272a032d4f8913ef5e8e53d5ba`.
- Published package tarball:
  `/var/folders/zc/53ddhl212mz7q515bcbwq3hw0000gn/T/tmp.nojJSVzYYf/openclaw-fs-safe-0.4.1.tgz`.
- Tarball SHA-256:
  `7b5f962e5c23f3574290fc7e5c8a6026bc4384de878027dd81a9efcfc61d2d69`.
- Base package patch SHA-256:
  `e49004277fcb3e714125baf15a996682c7310e8e9269c865cc5bcb9fef46a57c`.

The R4 worktree is clean. No product or test file changed. This source-only
campaign claims no landing, runtime, configuration, restart, database,
provider, gateway, or Slack surface during planning and review.

## Exact five-file boundary

1. `patches/@openclaw__fs-safe@0.4.1.patch`
2. `pnpm-lock.yaml`
3. `scripts/check-package-patches.mjs`
4. `src/infra/replace-file.test.ts`
5. `src/infra/json-files.test.ts`

The package patch can contain exactly these six package-relative sections:

1. `README.md`
2. `dist/pinned-python.js`
3. `dist/pinned-write.js`
4. `dist/replace-file.js`
5. `docs/atomic.md`
6. `docs/index.md`

## R3 evidence and terminal reason

R3 is preserved at:

- product candidate:
  `7247bf782859ea4aaec1610cfa6e40a6668b95cd`;
- terminal receipt commit:
  `c3b1d649c2345a086c4c785f60f8250178748878`;
- archive branch:
  `codex/archive/openclaw-fs-safe-atomic-replace-stage0-r3-stop-20260831`;
- worktree:
  `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r3-20260831`.

R3 proved the behavior with 62 focused tests and five patch-guard tests. Its
manual intended tree matched its manual patch-application tree. R3 stopped
because its zero-context patch did not produce the same pnpm-installed bytes.

The intended replacement SHA-256 was:

`0c2e300edf0e2cb6e25ab279ced40282c2af92a8f32caa1b6e8481ca2933747c`.

The pnpm-installed replacement SHA-256 was:

`83388c76e5ea352b7f959d8687b607c142a59b5d4288c669bff24967647940de`.

The installed drift affected `dist/pinned-python.js`,
`dist/pinned-write.js`, and `dist/replace-file.js`. In the replacement file,
pnpm moved temp registration before the write. Do not reuse the R3 patch file.

## Measured contextual patch size

A fresh planning measurement did this work in a disposable package Git
repository:

1. Extract the exact published tarball.
2. Commit the original package tree as the baseline.
3. Apply the R3 reviewed final patch with zero fuzz to reconstruct the intended
   final tree.
4. Generate `git diff --full-index --binary --no-ext-diff -- .` with normal
   three-line context.

The contextual patch had:

- 392 total patch lines;
- six sections and six unique package paths;
- SHA-256
  `9cb2b91283ac7a5b6ae3d1e4d28375af94e2628be47b14f9ea32d120cf227c42`;
- 320 added and zero deleted repository lines relative to the base package
  patch.

The old artificial package-patch cap was 280 changed lines. A realistic R4
package-patch cap is 340 changed lines. The five-file campaign cap can be 1,200
changed lines while keeping the existing test-owner limits.

## Required proof order

1. Add only the two focused test owners. Prove the base package fails the exact
   safety cases.
2. Run fresh uncommitted repository review. Commit the reviewed test-only red
   diff.
3. Generate one normal contextual patch from an exact temporary package Git
   repository.
4. Update the package patch, three lockfile hash bindings, and one guard
   comment.
5. Prove intended and manual package-tree equality.
6. Run all focused tests and guards to green. Run fresh uncommitted repository
   review. Commit the reviewed product diff.
7. In a clean isolated checkout, run bundled Node 24.19.0 and pnpm 11.19.0 with
   `pnpm install --frozen-lockfile --offline`.
8. Require the complete pnpm-installed package tree to equal the intended and
   manual trees. Run the focused tests and guards from that installed tree.
9. Freeze the exact candidate only after installed equality passes.
10. Run the required fresh exact-diff, adversarial, and acceptance reviews.

Stop before final review if pnpm-installed bytes differ, any test fails, a file
leaves the manifest, or a budget fails.
