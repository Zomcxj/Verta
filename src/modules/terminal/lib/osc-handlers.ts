import { IS_WINDOWS } from "@/lib/platform";

const MAX_OSC52_CLIPBOARD_BYTES = 1024 * 1024;

export function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/([^/]*)(\/.*)?$/);
  if (!m) return null;
  let authority = m[1];
  let path = m[2] ?? "";
  if (!path) return null;
  // The authority is decoded before the drive is looked for inside it, because the report is a
  // URI and an emitter escapes it: our own bash rcfile percent-encodes the colon, so a `$PWD` in
  // Windows form (`F:/dir`) is printed as `file://HOSTF%3A/dir` and the drive sits behind `%3A`
  // rather than a literal colon. Measured on this machine (2026-11-01), a pane opened at
  // `F:/VibeCoding_workspace/Verta` sends exactly that string; before this the drive was dropped
  // with the authority, the tab's cwd became `/VibeCoding_workspace/Verta`, and the file tree and
  // source control resolved it against the app's own drive and answered "the system cannot find
  // the path specified". A `%3A` from any other emitter is worth the same repair.
  try {
    authority = decodeURIComponent(authority);
  } catch {}
  // `file://HOSTF:/dir` (a Windows path with no slash in front of the drive): the drive
  // ends up inside the authority, and dropping it leaves `/dir`, which Windows then
  // resolves against whatever drive the app's own process sits on.
  const glued = authority.match(/^(.*?)([A-Za-z]:)$/);
  if (glued) {
    authority = glued[1];
    path = `/${glued[2]}${path}`;
  }
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  } else if (IS_WINDOWS) {
    // git-bash (MSYS) reports cwd as /c/Users/foo; map it to C:/Users/foo.
    const drive = path.match(/^\/([A-Za-z])(\/.*)?$/);
    if (drive) path = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  }
  return path;
}

export function parseOsc52Clipboard(data: string): string | null {
  const parts = data.split(";");
  if (parts.length < 2) return null;
  const selection = parts[0] || "c";
  if (!selection.includes("c")) return null;
  const encoded = parts.slice(1).join(";");
  if (!encoded || encoded === "?") return null;
  if (encoded.length > Math.ceil((MAX_OSC52_CLIPBOARD_BYTES * 4) / 3) + 4) {
    return null;
  }
  const compact = encoded.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;

  try {
    const bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    if (bytes.byteLength > MAX_OSC52_CLIPBOARD_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
