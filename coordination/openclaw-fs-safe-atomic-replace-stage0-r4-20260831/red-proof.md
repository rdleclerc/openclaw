# R4 Phase 1 red proof

Status: RED gate passed against the exact base package. The test-only diff
remains unchanged after proof and review. Phase 2 is not started.

## Identities

- Worktree: `/Users/rob/repos/worktrees/openclaw-fs-safe-atomic-replace-stage0-r4-20260831`.
- Branch: `codex/openclaw-fs-safe-atomic-replace-stage0-r4-20260831`.
- HEAD before the test-only diff:
  `c0ebebd15198bdf7e21fa3fa5da6c88d699fb489`.
- Exact OpenClaw source base:
  `0a1c7ad3b2fa79272a032d4f8913ef5e8e53d5ba`.
- Reviewed R3 test candidate:
  `7247bf782859ea4aaec1610cfa6e40a6668b95cd`.
- R4 `src/infra/replace-file.test.ts` Git blob:
  `414a4154a10a75bb511c8c54a6762142fc17873f`.
- R4 `src/infra/json-files.test.ts` Git blob:
  `fa679341b5753880aa205596c380bc2e3f856fe4`.
- Published package tarball:
  `/var/folders/zc/53ddhl212mz7q515bcbwq3hw0000gn/T/tmp.nojJSVzYYf/openclaw-fs-safe-0.4.1.tgz`.
- Published tarball SHA-256:
  `7b5f962e5c23f3574290fc7e5c8a6026bc4384de878027dd81a9efcfc61d2d69`.
- Base package patch SHA-256:
  `e49004277fcb3e714125baf15a996682c7310e8e9269c865cc5bcb9fef46a57c`.
- Dependency-ready worktree:
  `/Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830`.
- Dependency-ready HEAD:
  `79128560dbae74ca531bffa83936333366e10a69`.
- Base installed replacement SHA-256:
  `ce7adc55e93b9a9494c8ea6908097c3afeef8cf5298d254c28ccfa6180b68e1b`.
- Dependency-ready status after proof: clean.
- R3 worktree HEAD after proof:
  `c3b1d649c2345a086c4c785f60f8250178748878`.
- R3 worktree status after proof: clean.
- R2 worktree HEAD after proof:
  `6c61dcd2036aa315dfb9c86219c0e32334fae101`.
- R2 worktree status after proof: clean.

The exact published package source was inspected before implementation. In
`dist/replace-file.js`, the base async and sync paths use path-based
exclusive writes at lines 282 and 341, and invoke post-rename chmod at lines
299 and 358. The reviewed tests exercise those exact published call paths.

## Phase 1 scope and budgets

The only changed repository paths are:

- `src/infra/replace-file.test.ts`
- `src/infra/json-files.test.ts`

Changed-line budget against HEAD:

| File                             | Added | Deleted | Changed | Hard cap |
| -------------------------------- | ----: | ------: | ------: | -------: |
| `src/infra/replace-file.test.ts` |   783 |       0 |     783 |      800 |
| `src/infra/json-files.test.ts`   |     5 |       7 |      12 |       20 |
| Phase 1 total                    |   788 |       7 |     795 |      820 |

No package patch, lockfile, guard, product file, or other test file changed.

## Red command

The dependency-ready package tree was linked temporarily:

```sh
test ! -e node_modules
ln -s /Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830/node_modules node_modules
shasum -a 256 node_modules/@openclaw/fs-safe/dist/replace-file.js
node scripts/run-vitest.mjs src/infra/replace-file.test.ts src/infra/json-files.test.ts
red_exit=$?
rm node_modules
test ! -e node_modules
```

The base package hash was
`ce7adc55e93b9a9494c8ea6908097c3afeef8cf5298d254c28ccfa6180b68e1b`.
The test command exited 1. Vitest reported:

```
Test Files  2 failed (2)
Tests       30 failed | 32 passed (62)
```

Per-file result:

- `src/infra/replace-file.test.ts`: 49 tests, 28 failed and 21 passed.
- `src/infra/json-files.test.ts`: 13 tests, 2 failed and 11 passed.

The seven required failure groups matched exactly:

| Group                                                                                |  Cases | Result     |
| ------------------------------------------------------------------------------------ | -----: | ---------- |
| Terminal rename fallback fail-open, async/sync EPERM and EEXIST                      |      4 | failed     |
| Foreign regular-file, hardlink, FIFO, and symlink collisions                         |      8 | failed     |
| Destructive fallback interrupts the destination after remove, open, or partial write |      6 | failed     |
| Exit cleanup removes foreign regular-file and hardlink collisions                    |      4 | failed     |
| Temp ownership starts before the combined write completes                            |      2 | failed     |
| Cleanup failure leaves stale exit registration for regular and hardlink reuse        |      4 | failed     |
| JSON caller fail-open on Windows EPERM for regular and symlink destinations          |      2 | failed     |
| **Total**                                                                            | **30** | **failed** |

The 32 passing cases covered retained EBUSY retry, owned-temp cleanup,
cleanup-error wrapping, missing destinations, lexical aliases, destination
identity/mode/ownership, successful-reuse setup, the move helper, and JSON
helpers.

The successful-reuse cases use a real child process. The child creates a
foreign regular file at the former temp path during post-rename work, then
exits before the replacement call returns. Both cases pass against the base
package because the base package already unregisters immediately after a
successful rename. These cases protect that required behavior. Separate
collision and process-exit cases reproduce the unsafe early-registration and
cleanup behavior.

## Formatting and diff checks

Commands:

```sh
/Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830/node_modules/.bin/oxfmt   src/infra/replace-file.test.ts src/infra/json-files.test.ts
/Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830/node_modules/.bin/oxfmt --check   src/infra/replace-file.test.ts src/infra/json-files.test.ts
git diff --check
git diff --name-only
git diff --numstat
```

Results:

- Oxfmt write completed on 2 files.
- Oxfmt check passed for both files.
- `git diff --check` passed.
- Changed paths were exactly the two test owners listed above.
- Numstat was `783 0 src/infra/replace-file.test.ts` and
  `5 7 src/infra/json-files.test.ts`.

## Fresh uncommitted autoreview

Command:

```sh
TMPDIR=/tmp .agents/skills/autoreview/scripts/autoreview --mode uncommitted
```

Review result:

- exit code: 1;
- target: local;
- branch: `codex/openclaw-fs-safe-atomic-replace-stage0-r4-20260831`;
- engine: codex;
- model: `gpt-5.6-sol`;
- fallback model: `gpt-5.6-terra`;
- thinking: high;
- tools: on;
- web search: on;
- bundle: 32755 bytes;
- review passes: 1;
- findings: 3;
- overall: patch is incorrect (0.98).

The reviewer reported three P1 findings:

1. `src/infra/replace-file.test.ts:437`: omit
   `copyFallbackOnPermissionError: true` from rename-propagation tests.
2. `src/infra/replace-file.test.ts:475`: inject collisions through
   descriptor-based `open`/`openSync` writes.
3. `src/infra/replace-file.test.ts:311`: do not use post-rename
   `chmod`/`chmodSync` hooks for former-temp reuse.

Disposition: no finding is accepted or in scope. The frozen red gate requires
the base package to fail these cases, so the first finding would remove the
required four fail-open failures. The exact published `0.4.1` package uses
path-based `writeFile`/`writeFileSync` for the staging write and
post-rename `chmod`/`chmodSync`, as recorded above. The second and third
findings therefore review a different upstream call path, not the exact
published package named in the R4 packet. The reviewed R3 candidate has the
same tests and passed the recorded green proof. No accepted/actionable
finding remains. No test file changed after review, so no red proof rerun was
required after review.

## Cleanup and phase boundary

- R4 `node_modules` is absent after the test and formatter runs.
- Dependency-ready worktree remains clean at
  `79128560dbae74ca531bffa83936333366e10a69`.
- Preserved R3 worktree remains clean at
  `c3b1d649c2345a086c4c785f60f8250178748878`.
- Preserved R2 worktree remains clean at
  `6c61dcd2036aa315dfb9c86219c0e32334fae101`.
- No package patch, lockfile, guard, product, runtime, configuration,
  database, provider, gateway, landing, activation, restart, or Slack action
  occurred.
- Phase 2 has not started.
