# Independent R4 plan and KISS review

You are the required independent reviewer. Use `gpt-5.6-sol` at `ultra`
reasoning effort. Review only. Do not edit files, run implementation, commit,
push, deploy, restart, call providers, or use Slack. Do not spawn workers or
reviewers.

Read completely:

1. the original operator request in `operator-request.md`;
2. `source-packet.md`;
3. `fable-raw-plan.md`;
4. `frozen-plan.md`;
5. `frozen-manifest.md`;
6. `frozen-proof.md`;
7. R3 `terminal-stop.md`, `installed-package-proof.md`, and `green-proof.md`;
8. the exact five current source files;
9. the exact published 0.4.1 package source;
10. the canonical review policy from Gaia `origin/main`.

Verify source identity, scope fidelity, atomic-replace safety, collision safety,
cleanup ordering, public compatibility, contextual-patch reproducibility,
pnpm-installed byte authority, proof-first tests, budgets, review limits,
landing, activation, rollback, and KISS.

Return exactly one verdict: `CONTINUE`, `NARROW`, or `STOP`.

Also return:

- Scope fidelity: `PASS` or `FAIL`.
- Tier 3 correctness: `PASS` or `FAIL`.
- KISS: `PASS` or `FAIL`.
- Material findings with exact source or packet references.
- The smallest required action.

Product and test files remain unchanged. A non-`CONTINUE` verdict uses the one
allowed consolidated correction. A second non-`CONTINUE` verdict is terminal.
