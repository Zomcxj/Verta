import { describe, expect, it } from "vitest";
import { errorDetailOf } from "./appErrorFallback";

/**
 * What the panel that replaces a broken component says went wrong.
 *
 * A component that throws is not necessarily throwing an `Error`: a rejected promise can carry a
 * string, and something thrown by hand can be anything at all. The panel is the last thing standing
 * between a single bad component and a window with nothing in it, so it cannot be the second thing
 * that fails - it has to produce readable text from whatever it is handed.
 */

describe("errorDetailOf", () => {
  it("takes the name and the message off an error", () => {
    expect(errorDetailOf(new Error("boom"))).toEqual({
      name: "Error",
      detail: "boom",
    });
  });

  it("keeps the name a subclass gave itself", () => {
    class RenderError extends Error {
      override name = "RenderError";
    }
    expect(errorDetailOf(new RenderError("shader blew up"))).toEqual({
      name: "RenderError",
      detail: "shader blew up",
    });
  });

  it("says something for a value that is not an error", () => {
    expect(errorDetailOf("just a string")).toEqual({
      name: "Error",
      detail: "just a string",
    });
    expect(errorDetailOf({ message: "an object with a message" }).detail).toBe(
      "an object with a message",
    );
    expect(errorDetailOf(null).detail).toBe("null");
    expect(errorDetailOf(undefined).detail).toBe("undefined");
    expect(errorDetailOf(42).detail).toBe("42");
  });

  it("never hands back a blank detail", () => {
    // A thrown `new Error("")` would otherwise draw an empty panel: the one line the reader gets
    // would be nothing at all.
    expect(errorDetailOf(new Error("")).detail).toBe("Error");
    expect(errorDetailOf({ message: "   " }).detail).not.toBe("   ");
  });
});