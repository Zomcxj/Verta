/**
 * 项目路径的比较与整理。Windows 上同一个目录可以有多种写法（大小写、正反斜杠、结尾斜杠），
 * 清单的去重与「这个项目是不是已经开过空间」都靠这里的比较，避免出现两个看着一样的项目。
 */

/** 去掉结尾的分隔符，但盘符根（`C:\`）与 `/` 保留。 */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  // 去掉结尾的分隔符，再去掉可能因它露出来的空白（"F:\work\Verta \ " 这种粘贴痕迹）。
  const stripped = trimmed.replace(/[\\/]+$/, "").trimEnd();
  // `C:\` 去掉斜杠后是 `C:`，再拼回来才是盘根。
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped || "/";
}

/** 比较两个路径是否指同一个目录（大小写不敏感，分隔符统一）。 */
export function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return keyOf(a) === keyOf(b);
}

function keyOf(path: string): string {
  return normalizePath(path).replace(/\//g, "\\").toLowerCase();
}

/** 路径的最后一段，用作项目的默认显示名。 */
export function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

/**
 * 把新加的路径并进现有清单：已有（按同一目录判定）的不重复，新的一律追加在后面，
 * 保持用户看到的顺序稳定。
 */
export function mergeProjectPaths(
  existing: string[],
  added: string[],
): string[] {
  const out = [...existing];
  const seen = new Set(existing.map(keyOf));
  for (const raw of added) {
    const path = normalizePath(raw);
    if (!path) continue;
    const key = keyOf(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** 从清单里去掉一个路径；找不到就原样返回（调用方据此判断有没有改动）。 */
export function removeProjectPath(paths: string[], target: string): string[] {
  const key = keyOf(target);
  return paths.filter((path) => keyOf(path) !== key);
}