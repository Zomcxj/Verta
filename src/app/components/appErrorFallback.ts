/**
 * What to say about a value that was thrown.
 *
 * The panel that replaces a broken component is the last thing standing between one bad component
 * and a window with nothing in it, so it cannot be the second thing that fails. Whatever was thrown
 * has to become readable text: a component usually throws an `Error`, but a rejected promise can
 * carry a string, and code can throw a number, an object, or nothing at all.
 */
export type ErrorDetail = {
  /** The kind of thing that went wrong, for the reader who has seen a stack trace before. */
  name: string;
  /** Its own words, or the name again when it has none. */
  detail: string;
};

/** Whatever was thrown is not trusted to be an object, or to have the fields one would have. */
function nameOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return "Error";
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function errorDetailOf(error: unknown): ErrorDetail {
  const name = nameOf(error);
  const message = messageOf(error);
  // A thrown `new Error("")` would otherwise draw an empty line where the reason should be.
  return { name, detail: message.trim() === "" ? name : message };
}