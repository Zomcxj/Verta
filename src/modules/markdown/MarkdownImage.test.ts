import { describe, expect, it, vi } from "vitest";

// The asset protocol conversion is Tauri's; keep the real path visible in tests.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const { resolveImageSrc } = await import("./MarkdownImage");

describe("resolveImageSrc", () => {
  const base = "F:\\VibeCoding_workspace\\PasteLabel";

  it("joins a relative path onto the document directory", () => {
    expect(resolveImageSrc("./ico_image/demo.png", base)).toBe(
      "asset://F:\\VibeCoding_workspace\\PasteLabel\\ico_image\\demo.png",
    );
  });

  it("handles a relative path without the leading ./", () => {
    expect(resolveImageSrc("images/shot.png", base)).toBe(
      "asset://F:\\VibeCoding_workspace\\PasteLabel\\images\\shot.png",
    );
  });

  it("treats a leading slash as the document root, not the drive root", () => {
    // Markdown renderers normalize `./x.png` to `/x.png` before it gets here.
    expect(resolveImageSrc("/ico_image/demo.png", base)).toBe(
      "asset://F:\\VibeCoding_workspace\\PasteLabel\\ico_image\\demo.png",
    );
  });

  it("keeps the forward slash style of a POSIX base directory", () => {
    expect(resolveImageSrc("./a/b.png", "/home/me/docs")).toBe(
      "asset:///home/me/docs/a/b.png",
    );
  });

  it("uses an absolute path as given", () => {
    expect(resolveImageSrc("D:\\pics\\x.png", base)).toBe("asset://D:\\pics\\x.png");
    expect(resolveImageSrc("D:/pics/x.png", base)).toBe("asset://D:\\pics\\x.png");
  });

  it("passes remote, protocol relative and inline images through", () => {
    expect(resolveImageSrc("https://x.test/a.png", base)).toBe("https://x.test/a.png");
    expect(resolveImageSrc("//cdn.test/a.png", base)).toBe("//cdn.test/a.png");
    expect(resolveImageSrc("data:image/png;base64,AAA", base)).toBe(
      "data:image/png;base64,AAA",
    );
  });

  it("strips a fragment or query before resolving", () => {
    expect(resolveImageSrc("./a.png#frag", base)).toBe(
      "asset://F:\\VibeCoding_workspace\\PasteLabel\\a.png",
    );
  });

  it("percent-decodes the path", () => {
    expect(resolveImageSrc("./%E5%9B%BE.png", base)).toBe(
      "asset://F:\\VibeCoding_workspace\\PasteLabel\\图.png",
    );
  });

  it("handles a file:// reference", () => {
    expect(resolveImageSrc("file:///F:/x/y.png", base)).toBe("asset://F:\\x\\y.png");
  });

  it("returns null for nothing usable", () => {
    expect(resolveImageSrc(undefined, base)).toBeNull();
    expect(resolveImageSrc("   ", base)).toBeNull();
    expect(resolveImageSrc("#anchor", base)).toBeNull();
  });
});
