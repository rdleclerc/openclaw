import type { PluginRegistry } from "./registry-types.js";

/** Sum plugin-owned work that must settle before a graceful gateway restart. */
export function getPluginRestartBlockerCount(
  registry: Pick<PluginRegistry, "restartBlockers">,
): number {
  let total = 0;
  for (const blocker of registry.restartBlockers) {
    try {
      const count = blocker.getPendingCount();
      // An invalid plugin count is uncertain work, so keep restart fail-closed.
      total += Number.isSafeInteger(count) && count >= 0 ? count : 1;
    } catch {
      total += 1;
    }
  }
  return total;
}
