# Operator request

Build one fresh OpenClaw-only Stage 0 R4 repair for
`@openclaw/fs-safe@0.4.1`.

Keep the same five-file boundary and safety behavior as the stopped R3
campaign. Do not edit or reopen R3. Replace the unsafe zero-context package
patch with a normal contextual Git patch that pnpm installs byte-for-byte.

Required behavior:

- Terminal rename `EPERM` and `EEXIST` errors preserve the live destination
  and propagate the original error.
- Async and sync replacement do not own or register a generated temp path
  until exclusive create and write finish.
- Foreign regular-file, hardlink, FIFO, and symlink collisions remain
  unchanged.
- Exit-cleanup unregistration always occurs, including when owned-temp cleanup
  fails.
- Successful rename unregisters the former temp path before later chmod or
  parent-directory synchronization.
- Public option and result types remain compatible. Bounded `EBUSY` retry
  remains.

Use a normal contextual Git patch with sufficient surrounding lines. Set a
realistic patch-owner and total budget. Before final review, require exact
equality among the intended package tree, a manual patch application tree, and
the pnpm-installed package tree.

Add no service, queue, database, watcher, scheduler, runtime owner, or new
package-delivery mechanism. Do not start runtime or Slack actions during
planning, implementation, or review.
