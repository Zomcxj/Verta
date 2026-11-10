import { describe, expect, it } from "vitest";
import {
  extensionOf,
  hasImagePreview,
  IMAGE_EXTENSIONS,
  isImageExtension,
  isImagePath,
  isTextImageExtension,
  TEXT_IMAGE_EXTENSIONS,
} from "./imageFormats";

describe("what a picture is", () => {
  it("reads the extension whatever the path is spelled with", () => {
    expect(extensionOf("C:/a/b/photo.PNG")).toBe("png");
    expect(extensionOf("C:\\a\\b\\photo.Jpeg")).toBe("jpeg");
    expect(extensionOf("photo.tar.gz")).toBe("gz");
    expect(extensionOf("photo")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("draws every format the window can draw, and no more", () => {
    // The list is the one place the panes agree on; a format added here is added everywhere.
    expect([...IMAGE_EXTENSIONS]).toEqual([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "bmp",
      "ico",
    ]);
    for (const extension of IMAGE_EXTENSIONS) expect(isImageExtension(extension)).toBe(true);
    expect(isImageExtension("PNG")).toBe(true);
    // Not pictures: a document, a film, a format nothing here decodes.
    expect(isImageExtension("md")).toBe(false);
    expect(isImageExtension("mp4")).toBe(false);
    expect(isImageExtension("tiff")).toBe(false);
    expect(isImageExtension("wmf")).toBe(false);
    expect(isImageExtension("")).toBe(false);
  });

  it("counts an SVG as a picture beside the editor, not as one to paint instead of its text", () => {
    // Both panes have to agree about the same file: the column draws a thumbnail, the main view
    // opens the source, because an SVG *is* text that an editor can edit.
    expect([...TEXT_IMAGE_EXTENSIONS]).toEqual(["svg"]);
    expect(isTextImageExtension("svg")).toBe(true);
    expect(isImageExtension("svg")).toBe(false);
    expect(hasImagePreview("logo.svg")).toBe(true);
    expect(hasImagePreview("logo.png")).toBe(true);
    // And nothing else gets a column: an empty box implies something is missing.
    expect(hasImagePreview("readme.md")).toBe(false);
    expect(hasImagePreview("clip.mp4")).toBe(false);
  });

  it("sees both kinds as pictures when it is given a whole path", () => {
    expect(isImagePath("C:/pictures/a.bmp")).toBe(true);
    expect(isImagePath("C:/pictures/a.avif")).toBe(true);
    expect(isImagePath("C:/pictures/a.svg")).toBe(false);
    expect(isImagePath("C:/documents/a.docx")).toBe(false);
  });
});
