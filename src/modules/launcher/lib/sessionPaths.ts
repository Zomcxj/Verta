/**
 * 相对路径：把会话的 cwd 折成「相对当前工作区根」的写法，给右键菜单用。
 *
 * 只做字符串处理：会话的 cwd 与工作区根都来自同一台机器（`distro` 相同才比），
 * 不碰文件系统 —— 就算目录已经被删了，复制出这个相对路径仍然是用户想要的那条。
 */

/**
 * 统一分隔符、去掉尾部的 `/`。
 *
 * 不用正则写「反斜杠」：那些 `\\` 在编辑与转义里都太容易掉，用字符编码拼出来。
 */
const BACKSLASH = String.fromCharCode(92);

function normalize(path: string): string {
  let unified = "";
  for (const ch of path) unified += ch === BACKSLASH ? "/" : ch;
  while (unified.endsWith("/")) unified = unified.slice(0, -1);
  return unified;
}

/**
 * `cwd` 相对 `root` 的路径；不在 `root` 之下（或 `root` 为空）时是 `null`。
 *
 * 同一条路径返回 `"."`（表示就是根目录本身）。
 */
export function relativeToRoot(
  root: string | null | undefined,
  cwd: string | null | undefined,
): string | null {
  if (!root || cwd === null || cwd === undefined) return null;
  const base = normalize(root);
  const target = normalize(cwd);
  if (!base || !target) return null;
  if (target === base) return ".";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (!target.startsWith(prefix)) return null;
  return target.slice(prefix.length);
}
