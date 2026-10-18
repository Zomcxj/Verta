import { describe, expect, it } from "vitest";
import { sidePreviewKind } from "./SidePreview";

describe("sidePreviewKind", () => {
  it("renders markdown for markdown files, whatever the case", () => {
    expect(sidePreviewKind("C:\\docs\\readme.md")).toBe("markdown");
    expect(sidePreviewKind("/home/me/NOTES.MD")).toBe("markdown");
    expect(sidePreviewKind("a/b/guide.markdown")).toBe("markdown");
  });

  it("shows a thumbnail for pictures", () => {
    expect(sidePreviewKind("/tmp/shot.png")).toBe("image");
    expect(sidePreviewKind("/tmp/shot.JPG")).toBe("image");
    expect(sidePreviewKind("/tmp/anim.webp")).toBe("image");
  });

  it("offers nothing for files a side view cannot show", () => {
    expect(sidePreviewKind("/tmp/main.rs")).toBe("none");
    expect(sidePreviewKind("/tmp/readme.txt")).toBe("none");
    expect(sidePreviewKind("no-extension")).toBe("none");
  });

  it("does not treat a dotted directory as the extension", () => {
    // A path with no file extension at all must not borrow the folder's.
    expect(sidePreviewKind("/home/me.md/notes")).toBe("none");
  });
});
