import { describe, expect, it } from "vitest";
import { isModelLive } from "./modelLiveness";

/**
 * Whether a model is still worth holding on to.
 *
 * This is what stood between a disposed session and a window with nothing in it. The interface is
 * handed the model once and keeps it; the session that owns it can let go of it at any moment, from
 * code that has nothing to do with the component drawing it. The component asks this question before
 * it reaches into the model, because reaching into a disposed one throws - and a throw from an effect
 * is what takes the whole application down when nothing above it catches it.
 */

const alive = { isDisposed: () => false };
const disposed = { isDisposed: () => true };

describe("isModelLive", () => {
  it("says yes to a model that is alive", () => {
    expect(isModelLive(alive)).toBe(true);
  });

  it("says no to a model that has been disposed", () => {
    expect(isModelLive(disposed)).toBe(false);
  });

  it("says no when there is no model at all", () => {
    expect(isModelLive(null)).toBe(false);
    expect(isModelLive(undefined)).toBe(false);
  });

  it("says yes to a model that cannot answer the question", () => {
    // The check is optional on the interface: an implementation without it might well be alive, and
    // treating "cannot say" as dead would stop its terminal from working at all. This is the one place
    // where guessing wrong has to fail towards the terminal still working.
    expect(isModelLive({})).toBe(true);
  });
});