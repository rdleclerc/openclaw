# R4 Phase 2 green proof

Status: GREEN for the exact uncommitted package candidate, manual patch tree,
and dependency-ready overlay. No commit was made. The clean pnpm-installed-tree
proof remains deferred to Phase 3 and was not run.

## Frozen identity

- Worktree: /Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r4-20260831
- Branch: codex/openclaw-fs-safe-atomic-replace-stage0-r4-20260831
- R4 HEAD before the Phase 2 diff: 71b8c6f8d64c67a99f243e083dfbae3e41109a5e
- Exact source base: 0a1c7ad3b2fa79272a032d4f8913ef5e8e53d5ba
- Frozen red test commit: 6a299404b8d7bc90dcbf02a762b49e420b25417c
- Frozen plan SHA-256: 77bd83d9708707d96955164fbb0b61fcfa9575d9d4e6a6a61dc506fb75b6b3c7
- Frozen manifest SHA-256: bec82b42a11c45abf45fdf917e7ab62355f60b860732b3140bf91c057a4aed41
- Frozen proof SHA-256: 62f72e19d81a4ef321229b66908b0dbe1302c7b4ce093f619cd5e9af0e31703f
- Published package: @openclaw/fs-safe@0.4.1
- Published tarball: /var/folders/zc/53ddhl212mz7q515bcbwq3hw0000gn/T/tmp.nojJSVzYYf/openclaw-fs-safe-0.4.1.tgz
- Published tarball SHA-256: 7b5f962e5c23f3574290fc7e5c8a6026bc4384de878027dd81a9efcfc61d2d69
- Base package patch SHA-256: e49004277fcb3e714125baf15a996682c7310e8e9269c865cc5bcb9fef46a57c
- Temporary package baseline commit: a95f83a88919afa77885c0648950b17f429db5b5
- Temporary package Git tree: /tmp/openclaw-fs-safe-r4-package.G9y5mH/package

## Intended package tree and patch

The temporary package tree was extracted from the exact tarball, committed as
the baseline above, patched with the current base package patch using
patch --batch --forward --fuzz=0 -p1, and transformed from first principles.
No R3 package patch was reused.

The exact new package blobs are:

| Package path          | New blob                                 |
| --------------------- | ---------------------------------------- |
| README.md             | c72385e2a135363f24fdd49334b080edeeb36d72 |
| dist/pinned-python.js | f6f361974d48f8f4abd3f1e47f1fdb10bc3f2f77 |
| dist/pinned-write.js  | 09dd77aef95659865b93ce29e15f26e874dd0c25 |
| dist/replace-file.js  | 5538aedcf327655243baf34214c0c56c2bcdb9ce |
| docs/atomic.md        | 783030eddaf30a86da961bfeb91655fd81562ed1 |
| docs/index.md         | 590df733809d5966016c89176b058a011c2209b3 |

The intended dist/replace-file.js SHA-256 is
0c2e300edf0e2cb6e25ab279ced40282c2af92a8f32caa1b6e8481ca2933747c.

The repository patch was generated with this exact command and copied to
patches/@openclaw__fs-safe@0.4.1.patch:

    git diff --full-index --binary --no-ext-diff -- .

Patch gates all pass:

- 392 lines.
- SHA-256 9cb2b91283ac7a5b6ae3d1e4d28375af94e2628be47b14f9ea32d120cf227c42.
- Six sections and six unique paths, in frozen order: README.md,
  dist/pinned-python.js, dist/pinned-write.js, dist/replace-file.js,
  docs/atomic.md, and docs/index.md.
- Twenty hunk headers. Every hunk has non-empty old and new ranges and real
  unchanged context. No zero-context form or -U0 was used.
- Every section carries the exact frozen old/new blob pair. The six new pairs
  are the table above.
- Package patch owner numstat relative to the exact source base is 320 0.

A fresh manual extraction at
/tmp/openclaw-fs-safe-r4-manual.RvpZgU/package was patched with the repository
patch using zero fuzz. Its package version is 0.4.1, and its replacement-file
SHA-256 equals the intended hash above.

## Intended, manual, and overlay equality

A fresh overlay at /tmp/openclaw-fs-safe-r4-overlay.1ahAHf was extracted from
the exact tarball and patched with the same repository patch using zero fuzz.
The patched package is at
/tmp/openclaw-fs-safe-r4-overlay.1ahAHf/@openclaw/fs-safe. All other
dependency-ready node_modules entries were provided through absolute symlinks.
The overlay package version is 0.4.1, and its replacement-file SHA-256 equals
the intended hash above.

The deterministic manifest excluded only .git and the package root. Each row
recorded relative path, type, mode, size, symlink target, and SHA-256 for
regular files. Each tree had 310 rows. The intended, manual, and overlay
manifest files were byte-identical and had SHA-256
121df7e0321c42ee095926e17773b31a26d2a8c5da7b7617c438fc8f4e2d1096.

These comparisons produced no output:

    diff -u intended.jsonl manual.jsonl
    diff -u intended.jsonl overlay.jsonl
    diff -r -x .git /tmp/openclaw-fs-safe-r4-package.G9y5mH/package /tmp/openclaw-fs-safe-r4-manual.RvpZgU/package
    diff -r -x .git /tmp/openclaw-fs-safe-r4-package.G9y5mH/package /tmp/openclaw-fs-safe-r4-overlay.1ahAHf/@openclaw/fs-safe

## Red contract carried into green

The Phase 1 proof against the exact base installed package was:

    Test Files  2 failed (2)
    Tests 30 failed | 32 passed (62)

The required failure groups were present: four terminal EPERM/EEXIST fallback
failures; eight regular, hardlink, FIFO, and symlink foreign-temp collisions;
six destructive-fallback process-death cases; four registered-exit cleanup
foreign-collision cases; two exit-before-registration cases; four cleanup-error
name-reuse cases; and two JSON caller Windows-EPERM cases. The successful-reuse
cases create a foreign file at the former temp path during post-rename work and
exit before the replacement call returns. Process-exit cleanup preserves that
foreign file.

## Focused green proof

For each run, the R4 node_modules path was absent before the run, was linked
to the fresh overlay, and was removed after the run. The overlay Vitest cache
directories were fresh local disposable directories so no base-package cache
could be reused.

Command:

    node scripts/run-vitest.mjs src/infra/replace-file.test.ts src/infra/json-files.test.ts

Result: exit 0.

    Test Files  2 passed (2)
    Tests 62 passed (62)

Command:

    node scripts/run-vitest.mjs test/scripts/check-package-patches.test.ts

Result: exit 0.

    Test Files  1 passed (1)
    Tests 5 passed (5)

Command:

    node scripts/check-package-patches.mjs

Result: exit 0.

    PASS package patch guard: no new pnpm patches; 3 approved patches allowlisted.

The lockfile contains the new patch hash exactly three times and the old hash
zero times. The guard comment is the only changed guard content.

## Formatting, diff, and budgets

Formatter command:

    /Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830/node_modules/.bin/oxfmt --check src/infra/replace-file.test.ts src/infra/json-files.test.ts scripts/check-package-patches.mjs

Result: all three files use the correct format.

The normal-context patch necessarily contains nine blank context lines. The
outer repository diff represents each as plus-space, so default Git whitespace
rules report them as trailing whitespace. This invocation-scoped option was
used, and the command passed:

    git -c core.whitespace=-blank-at-eol diff --check

The worker briefly set the same option in the shared repository Git config.
The parent removed that setting before the candidate commit. Final readback
shows no configured `core.whitespace` value.

Current uncommitted Phase 2 product paths are exactly:

- patches/@openclaw__fs-safe@0.4.1.patch
- pnpm-lock.yaml
- scripts/check-package-patches.mjs

The exact five-file campaign numstat from the source base is:

| File                                   | Added | Deleted | Changed |   Cap |
| -------------------------------------- | ----: | ------: | ------: | ----: |
| patches/@openclaw__fs-safe@0.4.1.patch |   320 |       0 |     320 |   340 |
| pnpm-lock.yaml                         |     3 |       3 |       6 |     6 |
| scripts/check-package-patches.mjs      |     1 |       1 |       2 |     2 |
| src/infra/replace-file.test.ts         |   783 |       0 |     783 |   800 |
| src/infra/json-files.test.ts           |     5 |       7 |      12 |    20 |
| Total                                  | 1,112 |      11 |   1,123 | 1,200 |

The two test owners remain byte-identical to the frozen red commit.

## Fresh uncommitted autoreview

Command:

    TMPDIR=/tmp .agents/skills/autoreview/scripts/autoreview --mode uncommitted

Result: one review pass, exit 1, with one P2 finding. Review identity was
engine=codex, model=gpt-5.6-sol, fallback_model=gpt-5.6-terra,
thinking=high, tools=on, web_search=on, bundle=17714 bytes.

Finding:

    [P2] Track the temp file immediately after exclusive creation
    patches/@openclaw__fs-safe@0.4.1.patch:229

The reviewer proposed splitting exclusive creation from writing so a partial
write failure could be cleaned up. This finding is non-actionable for this
candidate. The frozen reviewed plan explicitly requires exclusive create and
write to finish before temp ownership and process-exit registration. That
ordering prevents exit cleanup from deleting a foreign collision. An orphaned
owned-name temp after process death in this short pre-registration interval is
the accepted trade-off. The exact six blob identities, intended replacement
hash, patch SHA, and focused tests are frozen to that behavior. No file changed
after this review, and no accepted in-scope finding remains.

## Cleanup and boundary

- R4 node_modules was restored to absent after every overlay run; final check:
  absent.
- Dependency-ready worktree:
  /Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830,
  HEAD 79128560dbae74ca531bffa83936333366e10a69, clean before and after.
- Preserved R3 worktree:
  /Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r3-20260831,
  HEAD c3b1d649c2345a086c4c785f60f8250178748878, clean before and after.
- Preserved R2 evidence worktree:
  /Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r2-20260831,
  HEAD 6c61dcd2036aa315dfb9c86219c0e32334fae101, clean before and after.
- The disposable package, manual, overlay, and manifest roots were removed
  after exact-prefix validation and receipt capture. No matching root remains.
- No commit was made. The clean pnpm installed-tree proof was not run.
- No Phase 2 landing, Phase 3 work, runtime, configuration, restart, database,
  provider, gateway, or Slack action occurred.
