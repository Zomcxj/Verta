export type Segment = {
  label: string;
  fullPath: string;
  isHome: boolean;
};

const WINDOWS_DRIVE = /^([A-Za-z]:)(.*)$/;

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

export function segmentsFromCwd(cwd: string, home: string | null): Segment[] {
  const normCwd = normalize(cwd);
  const normHome = home !== null ? normalize(home) : null;

  const usingHome =
    normHome !== null &&
    (normCwd === normHome || normCwd.startsWith(`${normHome}/`));

  let rootSegment: Segment;
  let tail: string;

  if (usingHome) {
    rootSegment = { label: "~", fullPath: normHome, isHome: true };
    tail = normCwd.slice(normHome.length).replace(/^\//, "");
  } else {
    const driveMatch = WINDOWS_DRIVE.exec(normCwd);
    if (driveMatch) {
      const drive = driveMatch[1];
      rootSegment = { label: drive, fullPath: `${drive}/`, isHome: false };
      tail = driveMatch[2].replace(/^\//, "");
    } else {
      rootSegment = { label: "/", fullPath: "/", isHome: false };
      tail = normCwd.replace(/^\//, "");
    }
  }

  const parts = tail === "" ? [] : tail.split("/").filter(Boolean);
  const segments: Segment[] = [rootSegment];

  let acc = rootSegment.fullPath;
  for (const part of parts) {
    acc = acc.endsWith("/") ? acc + part : `${acc}/${part}`;
    segments.push({ label: part, fullPath: acc, isHome: false });
  }
  return segments;
}

/**
 * The folder a path sits in, or `null` when it is a root and has nothing above it.
 *
 * `null` is what keeps a breadcrumb from offering to look beside `/` or beside `D:\`: there is no
 * listing above a root, and asking for one would be an error the user cannot act on.
 */
export function parentPath(path: string): string | null {
  const normalized = normalize(path).replace(/\/+$/, "");
  if (normalized === "") return null;
  if (WINDOWS_DRIVE.test(normalized) && normalized.length <= 2) return null;
  const at = normalized.lastIndexOf("/");
  if (at < 0) return null;
  const parent = normalized.slice(0, at);
  if (parent === "") return "/";
  // A drive's own path is spelled with a trailing separator: `C:` is not a folder, `C:/` is.
  return WINDOWS_DRIVE.test(parent) && parent.length === 2 ? `${parent}/` : parent;
}

/** A folder and the name of a child of it, as one path. */
export function childPath(folder: string, name: string): string {
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}
