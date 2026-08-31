PLAN

# R4 frozen plan: fs-safe fail-closed atomic replace, contextual patch delivery

## Context

`@openclaw/fs-safe@0.4.1` ships an atomic-replace path that is unsafe in three
ways. Terminal rename `EPERM`/`EEXIST` errors trigger a destructive copy
fallback that removes the live destination. The generated temp path is owned
and exit-registered before the exclusive create-plus-write finishes, so
foreign collision entries (regular file, hardlink, FIFO, symlink) get deleted
by cleanup and by exit cleanup. When owned-temp cleanup throws, the exit
registration leaks (`dist/replace-file.js` lines 309–319 and 373–386 skip the
trailing unregister).

R3 fixed all of this and proved it (62 focused tests, full byte proofs) but
stopped at the frozen installed-byte gate: its final package patch was
generated with `-U0` to satisfy an artificial 280-line cap, and pnpm applied
the contextless hunks at wrong nearby lines in three dist files
(R3 `terminal-stop.md`, `installed-package-proof.md`). R4 is a fresh campaign
from base `0a1c7ad3b2fa79272a032d4f8913ef5e8e53d5ba` that keeps the same
five-file boundary and behavior and changes exactly one variable: the package
patch is a normal contextual Git patch with a realistic budget, and
pnpm-installed bytes must equal the reviewed intended bytes before final
review.

Verified planning facts (all re-checked read-only in this session):

- R4 worktree is clean at exactly the base SHA; only untracked `coordination/`.
- Repo base patch SHA-256 `e49004277fcb…a57c` matches the packet; it is a
  _contextual_ patch and pnpm installs it byte-for-byte today (dependency-ready
  worktree `transcript-continuation-openclaw-r3-20260830` at `79128560dba`,
  clean, installed `dist/replace-file.js` = published hash `ce7adc55…b68e1b`).
  This is direct evidence the delivery path handles contextual patches.
- Published tarball at
  `/var/folders/zc/53ddhl212mz7q515bcbwq3hw0000gn/T/tmp.nojJSVzYYf/openclaw-fs-safe-0.4.1.tgz`
  hashes to `7b5f962e5c23f3574290fc7e5c8a6026bc4384de878027dd81a9efcfc61d2d69`.
- Lockfile carries the patch hash at exactly 3 lines (40, 90, 10009).
- Bundled Node `v24.19.0` and pnpm `11.19.0` exist at the R3-recorded paths.
- The packet's fresh measurement: default-context tree-pair patch = 392 patch
  lines, 6 sections, SHA-256 `9cb2b91283ac…227c42`, +320/−0 repository lines
  vs. the base patch file.

## Smallest architecture decision

Change only the patch **encoding**, not the mechanism, boundary, or behavior.

- Keep pnpm `patchedDependencies` as the delivery mechanism (already shipped,
  already proven for contextual patches by the live base patch).
- Regenerate the same reviewed tree-pair diff (tarball → intended final tree)
  with default three-line context instead of `-U0`, and set an honest 340-line
  patch-owner cap instead of the artificial 280.
- Re-execute the R3-proven test/proof pipeline from the clean R4 base, and add
  the gate R3 stopped on: intended = manual = pnpm-installed bytes, proven
  before final review.

### Non-goals

- No new package-delivery mechanism: no fork, no vendored copy, no version
  bump, no `pnpm` overrides, no postinstall rewriting.
- No service, queue, database, watcher, scheduler, or runtime owner.
- No change to any repo product source (`src/infra/replace-file.ts`,
  `src/infra/json-files.ts`, `fs-safe-defaults`), to `dist/*.d.ts`, or to the
  `movePathWithCopyFallback` contract/docs.
- No edit or reopen of R3/R2; their worktrees stay byte-identical and clean.
- No upstream fs-safe publish, no OpenClaw release, no CHANGELOG edit.
- No runtime, gateway, provider, database, or Slack action at any phase.

## Exact five-file manifest

1. `patches/@openclaw__fs-safe@0.4.1.patch` (replaced, contextual, 6 sections)
2. `pnpm-lock.yaml` (3 hash-binding lines)
3. `scripts/check-package-patches.mjs` (1 guard comment line)
4. `src/infra/replace-file.test.ts` (direct test owner)
5. `src/infra/json-files.test.ts` (JSON caller test owner)

The package patch contains exactly six package-relative sections, one per
path, in git path order: `README.md`, `dist/pinned-python.js`,
`dist/pinned-write.js`, `dist/replace-file.js`, `docs/atomic.md`,
`docs/index.md`.

## Budgets (changed lines = added + deleted vs. base `0a1c7ad3b2f`)

| File                                     |      Expected |       Cap |
| ---------------------------------------- | ------------: | --------: |
| `patches/@openclaw__fs-safe@0.4.1.patch` | +320/−0 = 320 |       340 |
| `pnpm-lock.yaml`                         |     +3/−3 = 6 |         6 |
| `scripts/check-package-patches.mjs`      |     +1/−1 = 2 |         2 |
| `src/infra/replace-file.test.ts`         | +783/−0 = 783 |       800 |
| `src/infra/json-files.test.ts`           |    +5/−7 = 12 |        20 |
| **Campaign total**                       |       ≈ 1,123 | **1,200** |

Check with `git diff --numstat 0a1c7ad3b2f` before each commit. Any file
outside the manifest, or any cap breach, is a stop.

## Exact package transformations (intended tree)

Baseline = exact tarball extraction, then the current repo base patch applied
with zero fuzz (this adds `fsync_best_effort` to `dist/pinned-python.js` and
`syncFileBestEffort` to `dist/pinned-write.js`; those two files change no
further). Then apply these edits. Line numbers refer to the published
`dist/replace-file.js`.

### `dist/replace-file.js` — shared deletions

1. Delete `isPermissionRenameError` (lines 11–14).
2. Delete `SUPPORTS_NOFOLLOW`, `OPEN_READ_FLAGS`, `OPEN_WRITE_EXCLUSIVE_FLAGS`
   (lines 15–20).
3. Delete the whole `copyFallbackReplace` (70–99) and
   `copyFallbackReplaceSync` (100–151) helpers.

### Async (`renameWithRetry`, `replaceFileAtomicUnserialized`)

4. In `renameWithRetry`, delete the copy-fallback branch (35–38). Terminal
   errors now always `throw error`. The `EBUSY` retry loop stays untouched.
5. Replace `const unregisterTempPath = registerTempPathForExit(tempPath);`
   (275) with `let unregisterTempPath;`.
6. Remove `tempExists = true;` from before the write (281). Directly after
   `await fsModule.writeFile(tempPath, options.content, { mode, flag: "wx" });`
   (282) insert, in this order: `tempExists = true;` then
   `unregisterTempPath = registerTempPathForExit(tempPath);`.
7. Delete the `copyFallbackOnPermissionError:` argument line (295).
8. Change the post-rename `unregisterTempPath();` (298) to
   `unregisterTempPath?.();` (rename success unregisters before `chmod` and
   parent-dir sync).
9. Rewrap the `finally` (309–319): an inner `try` holds
   `if (tempExists) { await cleanupTempFile({ … }); }`; an inner `finally`
   holds `unregisterTempPath?.();`. Delete the old trailing bare
   `unregisterTempPath();`. Unregistration now always runs, even when cleanup
   throws the wrapped cleanup error.

### Sync (`renameWithRetrySync`, `replaceFileAtomicSync`)

10. In `renameWithRetrySync`, delete the copy-fallback branch (61–64).
11. Replace the `const` registration (329) with `let unregisterTempPath;`.
12. Move `tempExists = true;` (340) to after `writeFileSync(...{ mode, flag:
"wx" })` (341) and add `unregisterTempPath = registerTempPathForExit(tempPath);`
    after it.
13. Delete the `copyFallbackOnPermissionError:` argument line (354).
14. Change `unregisterTempPath();` (357) to `unregisterTempPath?.();`.
15. Rewrap the `finally` (373–386): inner `try` holds the existing
    `if (tempExists) { try { rmSync … } catch (cleanupError) { … } }` block
    (cleanup-error wrapping message unchanged); outer inner-`finally` holds
    `unregisterTempPath?.();`.

Public compatibility invariants: `dist/replace-file.d.ts` is untouched, so
`copyFallbackOnPermissionError` stays an accepted, now-inert option and the
result type is unchanged; `"copy-fallback"` is simply never returned.

### Docs (claim corrections only)

- `README.md` line 221: drop "copy fallback on `EPERM`"; state terminal
  `EPERM`/`EEXIST` fail closed and preserve the destination.
- `docs/atomic.md`: 4 hunks — option comment ("retained for compatibility;
  terminal rename errors remain fail-closed"), heading `### EPERM and copy
fallback` → `### Terminal rename errors`, fallback paragraph → fail-closed
  paragraph, closing "custom copy-fallback policy" claim → fail-closed claim.
- `docs/index.md` line 54: table row "copy fallback" → "fail-closed terminal
  rename errors".
- Do not touch `movePathWithCopyFallback` documentation.

### Intended-tree identity gates (must all hold before patch generation)

`git hash-object` per file must equal the R3-reviewed final blobs:

| Path                    | Old blob        | New blob        |
| ----------------------- | --------------- | --------------- |
| `README.md`             | `3cfce6a32bc0…` | `c72385e2a135…` |
| `dist/pinned-python.js` | `c6177eaf5629…` | `f6f361974d48…` |
| `dist/pinned-write.js`  | `77d0ddfa5a1d…` | `09dd77aef956…` |
| `dist/replace-file.js`  | `81cc63607654…` | `5538aedcf327…` |
| `docs/atomic.md`        | `deb56f0b74d6…` | `783030eddaf3…` |
| `docs/index.md`         | `59866a3f5309…` | `590df733809d…` |

`shasum -a 256 dist/replace-file.js` must equal
`0c2e300edf0e2cb6e25ab279ced40282c2af92a8f32caa1b6e8481ca2933747c`.
These hashes come from the R3 patch index lines and receipts; matching them
proves tree equality with the reviewed intended tree without reusing the R3
patch file.

## Reproducible normal-context patch procedure

All disposable roots use exact prefixes under `/tmp`:
`openclaw-fs-safe-r4-package.*`, `-manual.*`, `-overlay.*`, `-installed.*`.

1. Verify tarball SHA-256 = `7b5f962e…d2d69`. Extract into
   `$(mktemp -d /tmp/openclaw-fs-safe-r4-package.XXXXXX)`; work in `package/`.
2. `git init`, local throwaway identity, `git add -A`, commit `baseline`.
3. Apply the current repo base patch (verify SHA `e49004…a57c` first):
   `patch --batch --forward --fuzz=0 -p1 < $R4/patches/@openclaw__fs-safe@0.4.1.patch`.
4. Apply the transformations above by direct edit. Run the intended-tree
   identity gates (blob table + replacement SHA).
5. Generate, from the package root:
   `git diff --full-index --binary --no-ext-diff -- . > generated.patch`
   (default three-line context; git 2.50.1 on this box, same as the
   measurement).
6. Patch-shape gates on `generated.patch`:
   - exactly 6 `^diff --git ` sections; the 6 unique paths above, each once;
   - each section's `index` line carries exactly the old/new blob pair from
     the table;
   - every hunk header `@@ -a,b +c,d @@` has `b ≥ 1` and `d ≥ 1`, and every
     hunk body contains leading-space context lines (no `-U0` shape anywhere);
   - expected 392 lines and SHA-256 `9cb2b91283ac7a5b6ae3d1e4d28375af94e2628be47b14f9ea32d120cf227c42`
     per the packet measurement. A mismatch with passing blob gates is
     stop-and-investigate, never force.
7. Copy `generated.patch` over `patches/@openclaw__fs-safe@0.4.1.patch`.
   Compute `NEW_SHA`. Rebind the lockfile: replace `e49004…a57c` with
   `NEW_SHA` at its 3 lines (40 `patchedDependencies`, 90 importer
   `patch_hash`, 10009 snapshot key). Require new-hash count = 3 and old-hash
   count = 0. Update the one guard comment in
   `scripts/check-package-patches.mjs` line 11 to
   `// Remove after fs-safe ships pinned-write fsync and fail-closed atomic replace.`
8. Expected repo numstat for the patch owner: +320/−0 (the contextual patch
   retains the base patch's two sections verbatim and adds four sections).

## Proof-first red cases and expected failures (Phase 1)

Author the two test owners first, as the only change. Use the R3-reviewed test
content (archive branch
`codex/archive/openclaw-fs-safe-atomic-replace-stage0-r3-stop-20260831`,
candidate `7247bf78285`) as the authoritative reference: 62 cases total —
injected-`fileSystem` rename-failure and EBUSY-retry cases, real-fs collision
fixtures, child-process exit cases via
`spawn(process.execPath, ["--input-type=module", "--eval", …])`, and the two
rewritten JSON caller cases (`propagates Windows rename EPERM and preserves
text`, `…and preserves symlink destinations`). Keep the existing
`movePathWithCopyFallback` hardlink test unchanged.

Red run against the exact **base** package:

```sh
# in $R4; node_modules must be absent first
ln -s /Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830/node_modules node_modules
shasum -a 256 node_modules/@openclaw/fs-safe/dist/replace-file.js   # require ce7adc55…b68e1b
node scripts/run-vitest.mjs src/infra/replace-file.test.ts src/infra/json-files.test.ts
rm node_modules                                                      # restore absent
```

Required result: exit 1, `30 failed | 32 passed (62)`; per file 28F/21P and
2F/11P. The 30 failures must land in exactly these seven groups:

1. Terminal rename fallback fail-open — 4 (async/sync × EPERM/EEXIST resolve
   `{ method: "copy-fallback" }` instead of propagating the original error).
2. Foreign generated-temp collision removed — 8 (async/sync × regular,
   hardlink, FIFO, symlink).
3. Destructive fallback interrupts the live destination — 6 (async/sync ×
   child exit after destination removal, after destination open, after strict
   partial write).
4. Exit cleanup removes foreign collision entries — 4 (async/sync × regular,
   hardlink).
5. Temp ownership before combined write completes — 2 (async/sync child-exit).
6. Cleanup failure leaves stale exit registration — 4 (async/sync × regular,
   hardlink name reuse).
7. JSON caller fail-open on Windows EPERM — 2 (regular, symlink destination).

The 32 passes cover retained behavior (EBUSY retry, owned-temp cleanup,
cleanup-error wrapping, missing destination, lexical alias, destination
identity/mode/ownership, successful-reuse unregistration, move helper, JSON
helpers). A different split without an explained cause is a stop.

Then: oxfmt write + check, `git diff --check`, fresh uncommitted review
(Gate B below), and commit the reviewed test-only red diff with
`git commit --no-verify` (dependency-less Codex worktree; the focused proof
above replaces committer hooks). Message style:
`test: reproduce fs-safe atomic replacement defects`.

## Green proof and three-tree equality (Phase 2)

After the patch/lockfile/guard update (only those three files change beyond
the frozen tests):

**Manual/intended equality (pre-commit):** extract the tarball fresh into
`…-manual.*`; apply the NEW repo patch with
`patch --batch --forward --fuzz=0 -p1`; require the manual tree to equal the
intended temp-repo tree by deterministic manifest (sorted rows: relpath, type,
mode, size, symlink target, SHA-256 for regular files; exclude `.git`;
310 rows expected) and by `diff -r -x .git` (empty).

**Focused green runs** against the exact final bytes via the R3 overlay
method: build `…-overlay.*/node_modules` with a fresh tarball extraction
patched by the new repo patch at `@openclaw/fs-safe` (verify its
`dist/replace-file.js` = `0c2e300e…747c`) and absolute symlinks to every other
dependency-ready `node_modules` entry; link `$R4/node_modules` to it for each
run; restore absent afterwards. The test suite itself distinguishes base from
final bytes (a wrong overlay reproduces the red split), so the run is
self-verifying.

```sh
node scripts/run-vitest.mjs src/infra/replace-file.test.ts src/infra/json-files.test.ts   # require 62 passed (62)
node scripts/run-vitest.mjs test/scripts/check-package-patches.test.ts                     # require 5 passed (5)
node scripts/check-package-patches.mjs   # require "PASS package patch guard: … 3 approved patches allowlisted."
/Users/rob/repos/worktrees/transcript-continuation-openclaw-r3-20260830/node_modules/.bin/oxfmt --check \
  src/infra/replace-file.test.ts src/infra/json-files.test.ts scripts/check-package-patches.mjs
git diff --check
git diff --numstat 0a1c7ad3b2f     # budgets table above
```

Then fresh uncommitted review on the full five-file diff (Gate C). Any
product/test change reruns green + review. Commit the reviewed exact diff
(`fix: make fs-safe replacement fail closed` style, `--no-verify`).

## pnpm-installed equality proof (Phase 3 — the gate R3 failed)

1. `git -C $R4 worktree add --detach $(mktemp -d /tmp/openclaw-fs-safe-r4-installed.XXXXXX) <product-commit>`;
   require clean status and absent `node_modules`.
2. Offline frozen install with bundled tools; the bundled Node dir must be
   first in `PATH` or lifecycle scripts resolve Homebrew Node 22 and the
   engine preinstall fails (R3-observed trap):

```sh
PATH=/Users/rob/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  /Users/rob/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm \
  install --frozen-lockfile --offline
```

Require exit 0 and `downloaded 0`. 3. Byte identity: `node_modules/@openclaw/fs-safe` must equal the intended and
manual trees — same 310-row manifest SHA, empty `diff -r` against both,
version `0.4.1`, installed `dist/replace-file.js` = `0c2e300e…747c`.
Note pnpm may report hunk offsets; only resulting bytes are authoritative. 4. From the installed checkout (its own real `node_modules`): rerun the 62
focused tests, the 5 patch-guard tests, the executable guard,
`./node_modules/.bin/oxfmt --check` on the three text owners, and
`git diff --check`; require clean status after. 5. Freeze the exact candidate SHA, all hashes, budgets, and receipts in the R4
coordination dir (mirror R3 naming: `frozen-plan.md`, `red-proof.md`,
`green-proof.md`, `installed-package-proof.md`, review receipts, ledger)
only after this equality passes.

## Review gates

Tier 3 (runtime-behavior change delivered into the OpenClaw runtime through a
patched dependency; data-preservation semantics): full four-phase ladder, each
review a fresh, isolated `gpt-5.6-sol` context at `ultra` effort; no
self-approval; one-correction rule per gate; if the Sol Ultra binding is
unavailable, stop and report locally-verified-only.

- **Gate A — independent plan review** of this frozen plan; `CONTINUE`
  required before any code change.
- **Gate B — fresh uncommitted review before the red commit**:
  `TMPDIR=/tmp .agents/skills/autoreview/scripts/autoreview --mode uncommitted`
  on the test-only diff; zero accepted/actionable findings.
- **Gate C — fresh uncommitted review before the product commit**: same
  command on the full five-file diff; findings that change files reopen the
  green proof.
- **Gate D — final reviews after installed equality and freeze**: fresh
  exact-diff review, fresh adversarial review, fresh acceptance review; all
  must return `CONTINUE`. Any requested change reopens Phases 2–3.

Known reviewer trap, pre-answered in receipts: registering the temp path
_before_ the write is rejected by the frozen contract — early registration is
exactly what lets exit cleanup delete foreign collision entries (red groups
2/4/5), and R3 adjudicated this finding as non-actionable.

## Landing, activation, native proof, rollback, cleanup, release

- **Landing:** only after Gate D and operator authorization. Rebase the R4
  branch on latest `origin/main`; require the five-file diff unchanged; land
  through the standard operator lane (matching prior `Land agent lanes:`
  commits). No CHANGELOG edit. Push nothing before authorization.
- **Activation:** the patch activates per checkout at its next pnpm install.
  After landing, refresh the dependency-ready worktree with a frozen offline
  install; require its installed `dist/replace-file.js` = `0c2e300e…747c`.
- **Native proof:** from that real (non-disposable) checkout, rerun the 62
  focused tests plus the executable guard natively and record the receipt.
  Live-gateway adoption rides the next normal upgrade cycle; no restart or
  runtime action belongs to R4.
- **Rollback:** `git revert` of the product commit restores the base patch
  bytes and the `e49004…a57c` binding at all 3 lockfile lines; a frozen
  install then restores base package bytes (verify `ce7adc55…b68e1b`). No
  state, config, or doctor migration exists on this surface. Keep receipts.
- **Cleanup:** `git worktree remove --force` the installed checkout; remove
  disposable roots only after exact-prefix validation; verify `$R4/node_modules`
  absent; verify the dependency-ready worktree (HEAD `79128560dba`) and the R3
  worktree remain clean and unchanged.
- **Release:** none in R4. The durable exit is upstream: fs-safe ships
  pinned-write fsync and fail-closed atomic replace in a new version, then a
  follow-up campaign bumps the dependency and deletes the patch, the allowlist
  entry, and the guard comment (the comment already names this debt).

## Stop conditions

Stop before the next phase, preserve the worktree, and write a terminal
receipt if any of these occur:

1. Any changed file outside the five-file manifest, or any budget cap breach.
2. Patch sections ≠ 6, duplicate paths, wrong path set, wrong blob pairs, or
   any hunk without real context lines.
3. Generated-patch bytes diverge from the measured 392-line/`9cb2b912…` form
   without an explained, reviewed cause.
4. Red split ≠ 30 failed / 32 passed in the named groups, unexplained.
5. Intended ≠ manual, or installed ≠ intended/manual, by manifest or `diff -r`;
   or installed version ≠ 0.4.1.
6. Offline install downloads > 0 packages, or any installed-tree test, guard,
   format, or diff check fails.
7. New lockfile hash count ≠ 3 or old hash count ≠ 0.
8. The dependency-ready, R3, or R2 worktree changes state.
9. Any required review does not return `CONTINUE` within the one-correction
   rule, or the Sol Ultra lane is unavailable.
10. Any runtime, landing, configuration, database, provider, gateway, or Slack
    surface would be touched before final review completes.

## KISS assessment

R4 changes one variable relative to a campaign that already proved the
behavior end-to-end: the patch encoding (default context instead of `-U0`) and
the honest cap that admits it (340 vs. 280). The delivery mechanism is the
existing pnpm patch flow, which demonstrably applies contextual patches
byte-for-byte today (the live base patch). No new runtime code, no new
mechanism, no new owner; the only build-time additions are the tree-pair
generation and byte-identity gates that directly prevent the R2/R3 failure
classes. The five-file boundary holds because the option stays type-compatible
and inert, so no repo product source changes. This is the smallest plan that
satisfies the operator contract.
