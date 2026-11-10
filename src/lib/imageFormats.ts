/**
 * What a picture is, by its extension - one table for every pane that shows one.
 *
 * Four panes grew their own list and drifted: the editor's main view knew `svg` and not `bmp`, the
 * column beside it knew `bmp` and `avif` and not `svg`, and the terminal knew four formats the other
 * two had never heard of. A file the sidebar drew a thumbnail of said "cannot be displayed" when it
 * was opened, which is a pane disagreeing with itself about the same bytes.
 *
 * The list is what a WebView2 window can draw by itself, and nothing more: no decoder of ours is in
 * this path, the picture is handed over as a `data:` URL or an asset URL and the webview paints it.
 * A format that is not here is not a smaller picture - it is one nothing can draw, and the panes say
 * so rather than pretending.
 *
 * `svg` is the one that is both: it is a picture, and its text is a document worth opening as source.
 * The main view opens it as text (a valid UTF-8 file, which is what an editor is for), while the
 * column beside the editor offers it as a thumbnail.
 */

/** The formats a webview draws by itself. */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
] as const;

/** Pictures whose text is a document: drawn as a thumbnail beside the editor, opened as text. */
export const TEXT_IMAGE_EXTENSIONS = ["svg"] as const;

const DRAWN = new Set<string>(IMAGE_EXTENSIONS);
const TEXT = new Set<string>(TEXT_IMAGE_EXTENSIONS);

/** The extension of a path, lowercased and without the dot. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at + 1).toLowerCase();
}

/** Whether an extension names a picture the window draws. */
export function isImageExtension(extension: string): boolean {
  return DRAWN.has(extension.toLowerCase());
}

/** Whether an extension is a picture whose own text is worth opening as source. */
export function isTextImageExtension(extension: string): boolean {
  return TEXT.has(extension.toLowerCase());
}

/** Whether a path is a picture the window draws. */
export function isImagePath(path: string): boolean {
  return isImageExtension(extensionOf(path));
}

/**
 * Whether a path is worth a picture column beside the editor.
 *
 * Both kinds are: a photo drawn as a thumbnail, and an SVG drawn as one while its text is what the
 * editor has open.
 */
export function hasImagePreview(path: string): boolean {
  const extension = extensionOf(path);
  return isImageExtension(extension) || isTextImageExtension(extension);
}
