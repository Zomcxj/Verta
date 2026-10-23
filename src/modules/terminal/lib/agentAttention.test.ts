import { describe, expect, it } from "vitest";
import {
  advanceAgentWatch,
  AGENT_QUIET_MS,
  EMPTY_AGENT_WATCH,
  type AgentWatch,
} from "./agentAttention";

const T0 = 1_000_000;

/** Runs a sequence of samples one second apart and returns what each reported. */
function run(
  samples: { bytes: number; hasChild: boolean }[],
  stepMs = 1000,
): ReturnType<typeof advanceAgentWatch>["attention"][] {
  let watch: AgentWatch = EMPTY_AGENT_WATCH;
  const out: ReturnType<typeof advanceAgentWatch>["attention"][] = [];
  samples.forEach((sample, i) => {
    const next = advanceAgentWatch(watch, sample, T0 + i * stepMs);
    watch = next.watch;
    out.push(next.attention);
  });
  return out;
}

describe("advanceAgentWatch", () => {
  it("says nothing for a tab whose agent has not painted yet", () => {
    // Ten seconds of an empty terminal: no CLI, so there is nothing to wait for.
    expect(run(Array.from({ length: 10 }, () => ({ bytes: 0, hasChild: false })))).toEqual(
      Array.from({ length: 10 }, () => null),
    );
  });

  it("raises a wait once the CLI goes silent long enough", () => {
    const silent = Math.ceil(AGENT_QUIET_MS / 1000) + 1;
    const attention = run([
      { bytes: 100, hasChild: true },
      ...Array.from({ length: silent }, () => ({ bytes: 100, hasChild: true })),
    ]);
    // First paint starts the clock; nothing to report on that same sample.
    expect(attention[0]).toBeNull();
    expect(attention.slice(1)).toContain("ask");
  });

  it("reports a single wait per quiet stretch", () => {
    const samples = [
      { bytes: 100, hasChild: true },
      ...Array.from({ length: 8 }, () => ({ bytes: 100, hasChild: true })),
    ];
    expect(run(samples).filter((a) => a === "ask")).toHaveLength(1);
  });

  it("stays quiet while the agent keeps painting", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      bytes: 100 + i * 40,
      hasChild: true,
    }));
    expect(run(samples).every((a) => a === null)).toBe(true);
  });

  it("reports again when a new run goes quiet after the previous answer", () => {
    const samples = [
      { bytes: 100, hasChild: true },
      ...Array.from({ length: 5 }, () => ({ bytes: 100, hasChild: true })),
      { bytes: 400, hasChild: true },
      ...Array.from({ length: 5 }, () => ({ bytes: 400, hasChild: true })),
    ];
    expect(run(samples).filter((a) => a === "ask")).toHaveLength(2);
  });

  it("reports the run finished when the child process goes away", () => {
    const attention = run([
      { bytes: 100, hasChild: true },
      { bytes: 200, hasChild: true },
      { bytes: 200, hasChild: false },
    ]);
    expect(attention).toEqual([null, null, "done"]);
  });

  it("does not call the shell's own exit a finished run", () => {
    // Never had a child: the leaf is a plain shell, not an agent that ended.
    expect(run([{ bytes: 0, hasChild: false }])).toEqual([null]);
  });

  it("prefers the finished report over a wait in the same sample", () => {
    const attention = run([
      { bytes: 100, hasChild: true },
      ...Array.from({ length: 5 }, () => ({ bytes: 100, hasChild: true })),
      { bytes: 100, hasChild: false },
    ]);
    expect(attention[attention.length - 1]).toBe("done");
  });
});
