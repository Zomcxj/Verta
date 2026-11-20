import { isImagePath } from "@/lib/imageFormats";

/**
 * The pictures beside the one that was opened, for the arrows in the image viewer.
 *
 * A folder is the only thing that says what "the next picture" means, and the window already knows
 * how to list one (`fs_read_dir`, natural-sorted, numeric-aware). This is the part of that answer the
 * viewer wants: files that a webview can draw, in the order the listing gave them - so `clip-2.png`
 * comes before `clip-10.png` rather than after it. A folder's own subfolders are not pages of it, and
 * a `symlink` to a picture is a picture.
 *
 * The separator comes from the path being viewed rather than from the platform: a workspace can be
 * a Windows path opened through a share, and joining `D:/shots` with `\` produces a path that means
 * something else.
 */
export function imageSiblingPaths(
  entries: readonly { name: string; kind: "file" | "dir" | "symlink" }[],
  folder: string,
): string[] {
  const separator = folder.includes("\\") ? "\\" : "/";
  const base = folder.endsWith(separator)
    ? folder.slice(0, -separator.length)
    : folder;
  return entries
    .filter(
      (entry) =>
        (entry.kind === "file" || entry.kind === "symlink") &&
        isImagePath(entry.name),
    )
    .map((entry) => `${base}${separator}${entry.name}`);
}

/** The folder a file is in, in the path's own spelling. `D:\shots\a.png` -> `D:\shots`. */
export function folderOf(path: string): string {
  const at = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return at <= 0 ? path : path.slice(0, at);
}

/** The file's own name, which is what the viewer's caption shows. */
export function nameOf(path: string): string {
  const at = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return at < 0 ? path : path.slice(at + 1);
}

/**
 * Which picture one arrow press lands on.
 *
 * The ends are ends: pressing past the first or the last picture stays where it is instead of
 * wrapping round, so the counter beside the arrows never jumps from the folder's oldest screenshot
 * to its newest without a sense of how far in it is. An empty list has nowhere to go, and a single
 * picture answers the index it was given.
 */
export function stepImage(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index + delta, 0), count - 1);
}
