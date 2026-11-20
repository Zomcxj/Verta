import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The window hears the background read, and both sides spell the event the same way.
 *
 * The stores are read once a minute on a thread of its own (`usage_refresh` on the Rust side) so that
 * opening the window does not pay for the scan. What makes that worth doing is this subscription: the
 * read finds something new, emits, and the window asks for the new answer - which the backend then
 * answers from the cache it already filled.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components. The
 * event name is a literal on both sides, so a rename in one language would otherwise fail silently -
 * the window would simply stop updating, which is the one failure this file exists to catch.
 */
const usage = readFileSync(new URL("./UsageApp.tsx", import.meta.url), "utf8");
const refresh = readFileSync(
  new URL(
    "../../src-tauri/src/modules/agent_sessions/usage_refresh.rs",
    import.meta.url,
  ),
  "utf8",
);

const EVENT = "verta://usage-changed";

describe("the usage window follows the background read", () => {
  it("subscribes to the event the backend emits", () => {
    expect(refresh).toContain(`pub const CHANGED_EVENT: &str = "${EVENT}";`);
    expect(usage).toContain(`listen("${EVENT}"`);
  });

  it("re-reads when it hears it, rather than only filling a label", () => {
    // The listener's body has to call the load, or the numbers stay as old as the window.
    const start = usage.indexOf(`listen("${EVENT}"`);
    expect(start, "the subscription is gone").toBeGreaterThan(-1);
    const body = usage.slice(start, usage.indexOf("})", start));
    expect(body).toContain("load()");
  });

  it("lets go of the subscription when the window closes", () => {
    // A window that keeps its listener after unmount leaks one per open, and the second copy would
    // answer into a component that no longer exists.
    const start = usage.indexOf(`listen("${EVENT}"`);
    const after = usage.slice(start, start + 900);
    expect(after).toContain("off?.()");
  });
});
