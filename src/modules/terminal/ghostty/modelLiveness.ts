/**
 * The part of a terminal model that can answer whether it is still there.
 *
 * Structural rather than the model interface itself: this question is asked of whatever the session
 * hands over, and writing it out keeps the answer testable without a WebAssembly core. Every member
 * is optional on purpose - a model that cannot answer is not a model that is gone.
 */
export type DisposalAware = { isDisposed?: () => boolean };

/**
 * Whether a model is still worth holding on to.
 *
 * A model outlives neither its session nor the component drawing that session, and the two are not
 * coordinated: the session can let go of its model from code that has nothing to do with the
 * component, and the component goes on holding what it was handed. Everything it does to a model
 * that is gone throws, and a throw from an effect is what takes the whole window down when there is
 * nothing above it to catch it - measured on the installed build, as a window left with an empty
 * screen and nothing but the acrylic behind it. So it asks first.
 *
 * Two answers are deliberate. No model at all is not live: there is nothing to hold on to. A model
 * that cannot answer the question - one from a backend that never had to be disposed - is treated as
 * live, because guessing wrong in that direction only means the terminal works.
 */
export function isModelLive(model: DisposalAware | null | undefined): boolean {
  if (model === null || model === undefined) return false;
  return model.isDisposed?.() !== true;
}