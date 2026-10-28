import { describe, expect, it, vi } from "vitest";
import { disposeGhosttySessionResources } from "./useGhosttyTerminalSession";

/**
 * What tearing a session's resources down has to leave behind.
 *
 * A real session is built out of a WebAssembly core and a GPU surface, and none of that is needed to
 * answer this: the teardown asks each part to dispose itself and tells the surface that was drawing
 * the session. What matters is the telling - the React side holds the model the session handed it, and
 * a model that has been disposed but is still held is what took the whole window down: the accessible
 * output went on to subscribe to it, the subscription refuses a dead model, and the error, thrown from
 * a passive effect with nothing above it to catch it, unmounted the application.
 */
function resources() {
  return {
    leafId: 9_999,
    input: { dispose: vi.fn() },
    surface: { dispose: vi.fn() },
    model: { dispose: vi.fn() },
    ptyResize: { reset: vi.fn() },
    writer: { dispose: vi.fn() },
    callbacks: { onModel: vi.fn() },
  };
}

describe("disposing a session's resources", () => {
  it("tells the surface the model is gone, as well as disposing it", () => {
    const session = resources();
    // Held here, because the point of the call is that the session no longer holds them.
    const model = session.model;

    disposeGhosttySessionResources(session);

    expect(model.dispose).toHaveBeenCalledTimes(1);
    // The half that was missing: without it, whatever still holds the model goes on using it.
    expect(session.callbacks.onModel).toHaveBeenCalledWith(null);
    expect(session.model).toBeNull();
  });

  it("disposes the rest of it too", () => {
    const session = resources();
    const input = session.input;
    const surface = session.surface;

    disposeGhosttySessionResources(session);

    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(session.ptyResize.reset).toHaveBeenCalledTimes(1);
    expect(session.writer.dispose).toHaveBeenCalledTimes(1);
  });

  it("survives a session that never got as far as having a model or a surface", () => {
    // A session whose initialization failed has already dropped these, and disposal still has to run.
    const session = {
      leafId: 9_999,
      input: null,
      surface: null,
      model: null,
      ptyResize: { reset: vi.fn() },
      writer: { dispose: vi.fn() },
      callbacks: {},
    };

    expect(() => disposeGhosttySessionResources(session)).not.toThrow();
    expect(session.writer.dispose).toHaveBeenCalledTimes(1);
  });
});