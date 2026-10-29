import { describe, expect, it, vi } from "vitest";
import {
  disposeGhosttySessionResources,
  releaseGhosttySessionForFailure,
} from "./useGhosttyTerminalSession";

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

/**
 * The other door: a session that never managed to start.
 *
 * This is the one the window actually came down through - a terminal whose renderer could not be
 * created (`WebGL2 is unavailable`, measured) has its model disposed and nulled here, and the surface
 * that was handed the model before the renderer existed was never told. React went on holding it, the
 * accessible output subscribed to it on the next visibility change, and the throw emptied the window.
 */
describe("giving up on a session that could not start", () => {
  function failed() {
    return {
      leafId: 9_999,
      input: { dispose: vi.fn() },
      surface: { dispose: vi.fn() },
      surfaceOptions: { some: "options" },
      model: { dispose: vi.fn() },
      ptyResize: { reset: vi.fn() },
      writer: { clear: vi.fn() },
      callbacks: { onModel: vi.fn() },
    };
  }

  it("tells the surface the model is gone", () => {
    const session = failed();
    const model = session.model;

    releaseGhosttySessionForFailure(session);

    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(session.callbacks.onModel).toHaveBeenCalledWith(null);
    expect(session.model).toBeNull();
  });

  it("hands back the rest of what it was holding", () => {
    const session = failed();
    const input = session.input;
    const surface = session.surface;

    releaseGhosttySessionForFailure(session);

    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(session.surface).toBeNull();
    expect(session.surfaceOptions).toBeNull();
    // Cleared rather than disposed, which is what this path has always done.
    expect(session.writer.clear).toHaveBeenCalledTimes(1);
    expect(session.ptyResize.reset).toHaveBeenCalledTimes(1);
  });
});