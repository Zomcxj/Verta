import type { MessageKey } from "@/modules/i18n";

/**
 * The line under a stopped language server, resolved at render time.
 *
 * The reason comes from the other side, written in Rust (`modules/lsp/session.rs`), and the rule for
 * text that crosses that boundary is that the side producing it stops producing copy: until it can
 * hand over a key, the frontend maps the sentences it knows and passes anything else through as it
 * came. That is the same shape the git status labels use, so the mapping lives here rather than in
 * the store: the store keeps what Rust said, and each render turns it into the current language.
 */
export type ExitReason = {
  key: MessageKey;
  values?: Record<string, string | number>;
};

/**
 * `Killed after exceeding the 512 MB memory budget (600 MB resident).`, as `session.rs` writes it.
 * The numbers are read back out of the sentence, which is the cost of mapping rather than emitting a
 * key: the sentence is pinned by that file, so a change there fails this pattern's test.
 */
const MEMORY_BUDGET =
  /^Killed after exceeding the (\d+) MB memory budget \((\d+) MB resident\)\.$/;

export function exitReasonMessage(reason: string): ExitReason {
  const budget = MEMORY_BUDGET.exec(reason);
  if (budget) {
    return {
      key: "lsp.memoryBudget",
      values: { budget: budget[1], resident: budget[2] },
    };
  }
  // Anything else (a crash code, stderr text) is shown as it arrived.
  return { key: reason as MessageKey };
}