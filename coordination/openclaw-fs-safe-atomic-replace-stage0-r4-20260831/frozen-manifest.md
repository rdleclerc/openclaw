# Frozen R4 manifest and budgets

Exact source base:
`0a1c7ad3b2fa79272a032d4f8913ef5e8e53d5ba`.

## Repository files

| File                                     | Expected changed lines | Hard cap |
| ---------------------------------------- | ---------------------: | -------: |
| `patches/@openclaw__fs-safe@0.4.1.patch` |                    320 |      340 |
| `pnpm-lock.yaml`                         |                      6 |        6 |
| `scripts/check-package-patches.mjs`      |                      2 |        2 |
| `src/infra/replace-file.test.ts`         |                    783 |      800 |
| `src/infra/json-files.test.ts`           |                     12 |       20 |
| Total                                    |            about 1,123 |    1,200 |

No product or test file outside this table can change.

## Package patch sections

The package patch must have one section for each path and no other section:

1. `README.md`
2. `dist/pinned-python.js`
3. `dist/pinned-write.js`
4. `dist/replace-file.js`
5. `docs/atomic.md`
6. `docs/index.md`

The patch must use normal Git context. It must not use zero-context hunks.
Every hunk must contain real unchanged context lines.

## Mechanism boundary

Reuse pnpm patched dependencies, the current lockfile bindings, the existing
package-patch guard, and the two existing focused test owners. Add no service,
queue, database, watcher, scheduler, runtime owner, package fork, vendored
package, postinstall rewrite, or version override.
