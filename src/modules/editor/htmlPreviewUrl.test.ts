import { describe, expect, it } from "vitest";
import { encodeAssetPath, htmlPreviewUrl } from "./htmlPreviewUrl";

describe("encodeAssetPath", () => {
  it("keeps the separators a browser resolves against", () => {
    // The whole point: `./style.css` is resolved by replacing the last segment, so a page's own
    // directory has to still look like one.
    expect(encodeAssetPath("D:\\VsPro\\Verta\\docs\\page.html")).toBe(
      "D%3A/VsPro/Verta/docs/page.html",
    );
    expect(encodeAssetPath("/home/me/docs/page.html")).toBe(
      "%2F/home/me/docs/page.html",
    );
  });

  it("keeps an absolute path absolute", () => {
    // The handler decodes everything after the leading `/` and opens it as a path, so a POSIX root
    // has to arrive encoded - otherwise `/home/me` becomes `home/me`, which is relative.
    expect(encodeAssetPath("/home/me/page.html").startsWith("%2F/")).toBe(true);
    // A UNC share is the same story on Windows.
    expect(encodeAssetPath("\\\\server\\share\\page.html")).toBe(
      "%2F%2F/server/share/page.html",
    );
    // A drive letter is absolute without a leading separator.
    expect(encodeAssetPath("D:/page.html")).toBe("D%3A/page.html");
  });

  it("encodes what is not safe in a URL and leaves the rest alone", () => {
    expect(encodeAssetPath("/home/me/终端 智能体.html")).toBe(
      "%2F/home/me/%E7%BB%88%E7%AB%AF%20%E6%99%BA%E8%83%BD%E4%BD%93.html",
    );
    // `#` and `?` would end the path or start a query.
    expect(encodeAssetPath("/home/me/a#b?c.html")).toBe("%2F/home/me/a%23b%3Fc.html");
  });

  it("collapses repeated separators rather than inventing empty segments", () => {
    expect(encodeAssetPath("D:\\\\a\\\\\\b.html")).toBe("D%3A/a/b.html");
  });
});

describe("htmlPreviewUrl", () => {
  it("puts the encoded path behind the platform's own prefix", () => {
    expect(htmlPreviewUrl("/home/me/docs/page.html", "asset://localhost/")).toBe(
      "asset://localhost/%2F/home/me/docs/page.html",
    );
    expect(
      htmlPreviewUrl("D:\\docs\\page.html", "http://asset.localhost/"),
    ).toBe("http://asset.localhost/D%3A/docs/page.html");
  });

  it("resolves a sibling reference to the file beside the page", () => {
    // What the browser does with `./style.css`, spelled out in the handler's own terms: skip the
    // leading `/`, decode, open as a path. A sibling has to land beside the page and `../` one
    // directory up, which is what the single-segment form could not express.
    const opened = (url: string) =>
      decodeURIComponent(new URL(url).pathname.slice(1));
    const page = htmlPreviewUrl("/docs/page.html", "asset://localhost/");
    // `//` at the front of a POSIX path is the encoded root plus the separator that keeps it from
    // being popped; the OS collapses it.
    expect(opened(page)).toBe("//docs/page.html");
    expect(opened(new URL("./style.css", page).href)).toBe("//docs/style.css");
    expect(opened(new URL("../shared.css", page).href)).toBe("//shared.css");
  });

  it("resolves the same way on Windows, where the path has a drive instead of a root", () => {
    const opened = (url: string) =>
      decodeURIComponent(new URL(url).pathname.slice(1));
    const page = htmlPreviewUrl("D:\\docs\\page.html", "http://asset.localhost/");
    expect(opened(page)).toBe("D:/docs/page.html");
    expect(opened(new URL("./style.css", page).href)).toBe("D:/docs/style.css");
    expect(opened(new URL("../shared.css", page).href)).toBe("D:/shared.css");
  });
});
