import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * A path as the asset protocol wants to receive it, with its separators still separators.
 *
 * `convertFileSrc` percent-encodes the whole path as *one* URL segment. That is right for an `<img>`
 * or a PDF frame, where nothing is ever resolved against the URL, and wrong for a document: a browser
 * resolves `./style.css` by replacing the last path segment, and with a single segment there is no
 * directory left to resolve against, so every relative reference in the page collapses to
 * `http://asset.localhost/style.css`. Measured on a two-stylesheet test page: both sheets loaded zero
 * rules and it rendered as unstyled text.
 *
 * The asset handler decodes everything after the leading `/` and opens the result as a path, so the
 * path is handed over segment by segment: real `/` for the browser to resolve against, and the
 * leading separators (`/home`, `\\server`) encoded so the decoded path is still absolute.
 */
export function encodeAssetPath(path: string): string {
  const leading = path.match(/^[\\/]+/)?.[0] ?? "";
  const segments = path
    .slice(leading.length)
    .split(/[\\/]+/)
    .filter((segment) => segment !== "")
    .map(encodeURIComponent);
  // A leading run arrives encoded *and* is followed by a real separator: encoded, so the decoded
  // path is still absolute; separated, so a `..` in the page cannot pop the root off the URL and
  // leave the asset handler with a relative path.
  const root = leading === "" ? "" : `${encodeURIComponent(leading.replace(/\\/g, "/"))}/`;
  return root + segments.join("/");
}

/**
 * The asset protocol's own prefix, asked of the API rather than assumed per platform: Windows serves
 * `http://asset.localhost/`, the other platforms `asset://localhost/`.
 */
function assetPrefix(): string {
  const encoded = encodeURIComponent("\u0000");
  const url = convertFileSrc("\u0000");
  return url.slice(0, url.length - encoded.length);
}

/** A file's asset URL, with its path left as path so a document's relative references resolve. */
export function htmlPreviewUrl(path: string, prefix = assetPrefix()): string {
  return prefix + encodeAssetPath(path);
}
