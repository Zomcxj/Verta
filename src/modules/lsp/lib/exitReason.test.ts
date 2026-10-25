import { describe, expect, it } from "vitest";
import { exitReasonMessage } from "./exitReason";

describe("exitReasonMessage", () => {
  it("turns the memory-budget sentence into a key with its numbers", () => {
    expect(
      exitReasonMessage(
        "Killed after exceeding the 512 MB memory budget (600 MB resident).",
      ),
    ).toEqual({
      key: "lsp.memoryBudget",
      values: { budget: "512", resident: "600" },
    });
  });

  it("passes any other reason through as it arrived", () => {
    expect(exitReasonMessage("Error: spawn rust-analyzer ENOENT")).toEqual({
      key: "Error: spawn rust-analyzer ENOENT",
    });
  });

  it("does not turn a sentence that only looks like the budget one into a key", () => {
    // A stderr tail that happens to start the same way still carries more after the sentence, and
    // that is not the sentence the backend wrote.
    expect(
      exitReasonMessage(
        "Killed after exceeding the 512 MB memory budget (600 MB resident). More text follows.",
      ),
    ).toEqual({
      key: "Killed after exceeding the 512 MB memory budget (600 MB resident). More text follows.",
    });
  });
});