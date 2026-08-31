# Frozen R4 proof contract

## Red gate

Run 62 focused tests against the exact base installed package. Require 30
failures and 32 passes. The failures must cover:

1. terminal permission fallback;
2. regular-file, hardlink, FIFO, and symlink temp collisions;
3. process death during destructive fallback;
4. registered exit cleanup of foreign collisions;
5. exit before temp registration after exclusive write;
6. cleanup failure followed by safe filename reuse;
7. the two JSON caller paths.

The success cases must create a foreign file at the former temp path during
post-rename work and exit before the replacement call returns. Process-exit
cleanup must preserve that file.

Before the red commit, require formatting, diff checks, exact changed paths,
budgets, and fresh uncommitted review.

## Contextual patch gate

Require:

- exact tarball and base-patch hashes;
- normal three-line Git context without `-U0`;
- six sections and six unique frozen package paths;
- every hunk has unchanged context lines;
- exact old and new package blob pairs;
- 392 patch lines and SHA-256
  `9cb2b91283ac7a5b6ae3d1e4d28375af94e2628be47b14f9ea32d120cf227c42`;
- exact intended replacement SHA-256
  `0c2e300edf0e2cb6e25ab279ced40282c2af92a8f32caa1b6e8481ca2933747c`.

## Green and installed gates

Before the product commit, require 62 of 62 focused tests, five of five
patch-guard tests, the executable guard, formatting, diff checks, budgets, and
fresh uncommitted review.

Before candidate freeze, require:

- a clean isolated checkout of the exact product commit;
- bundled Node 24.19.0 and pnpm 11.19.0;
- offline frozen install with zero downloads;
- package version 0.4.1;
- the new patch hash at exactly three lockfile locations;
- complete intended, manual, and pnpm-installed package manifests equal;
- `diff -r` reports no package difference;
- installed replacement SHA-256 equals the intended SHA-256;
- 62 of 62 focused tests and five of five patch-guard tests pass from the
  installed checkout;
- the executable guard, formatting, and diff checks pass;
- the isolated checkout is clean after proof;
- disposable proof roots are removed after exact-prefix validation;
- R2 and R3 evidence lanes remain unchanged.

No overlay-only result can replace the clean pnpm-installed proof.
