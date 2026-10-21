import type { WireRepoSettingsPayload } from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";

/** 仓库描述的长度上限，与 Rust 侧 `repo_admin::DESCRIPTION_MAX_CHARS` 一致。 */
export const DESCRIPTION_MAX_CHARS = 350;

/**
 * 能不能改这个仓库的设置（描述 / 可见性 / 删除）。
 *
 * 与权限门禁同一套取舍：**没查出来、以及查不动（没装 gh / 没登录 / 出错）都返回 true**，
 * 按钮照常渲染，点下去由 GitHub 拒绝并把原话透传出来。
 */
export function canAdmin(payload: WireRepoSettingsPayload | null): boolean {
  return payload ? payload.canAdmin : true;
}

/** 「这个仓库你改不了」那句话的键；没有这句话时是 null。 */
export function adminHintKey(
  payload: WireRepoSettingsPayload | null,
): MessageKey | null {
  if (payload?.kind !== "ready") return null;
  return payload.canAdmin ? null : "remotes.admin.readOnly";
}

/**
 * `PUBLIC` / `PRIVATE` 折成「是不是私有」。
 *
 * 组织内可见（`INTERNAL`）与拿不到值时返回 null：这时候界面上不该替它说「私有」或「公开」，
 * 只显示 GitHub 原样的词。
 */
export function isPrivateVisibility(visibility: string | null): boolean | null {
  const value = visibility?.trim().toUpperCase();
  if (value === "PUBLIC") return false;
  if (value === "PRIVATE") return true;
  return null;
}

/**
 * 删仓库前的确认：手输的仓库全名必须一字不差（大小写不敏感，GitHub 的仓库名本来就不分）。
 *
 * 这是不可撤销操作前的最后一道闸，故意不做模糊匹配。
 */
export function deleteConfirmMatches(typed: string, fullName: string): boolean {
  const a = typed.trim();
  if (!a) return false;
  return a.toLowerCase() === fullName.trim().toLowerCase();
}

/** 描述在本地能不能过；不能过时给个理由。 */
export function descriptionProblem(description: string): "tooLong" | null {
  return description.trim().length > DESCRIPTION_MAX_CHARS ? "tooLong" : null;
}

/**
 * 克隆目标的默认值：落在已有项目的**同一级**目录下，名字用仓库名。
 *
 * 没有已有项目（或路径为空）时返回空串——那就让用户自己填，别猜一个可能不存在的地方。
 * 分隔符跟随传入的路径，Windows 上用反斜杠。
 */
export function cloneDestBeside(
  existingProjectPath: string | null,
  name: string,
): string {
  const raw = existingProjectPath?.trim() ?? "";
  if (!raw || !name.trim()) return "";
  // 分隔符看原路径：`F:\Verta` 的上一级是 `F:`，光看它认不出该用哪种斜杠。
  const separator = raw.includes("\\") ? "\\" : "/";
  const parent = parentOf(raw);
  if (!parent) return "";
  return parent.endsWith(separator)
    ? `${parent}${name}`
    : `${parent}${separator}${name}`;
}

/**
 * 从项目清单里挑一条做参照，算出克隆目标目录。
 *
 * 清单里可能有算不出上一级的条目（比如手输了一半的名字），所以逐条试，用第一条算得出结果的；
 * 一条都不行就返回空串，让用户自己填。
 */
export function cloneDestFromProjects(paths: string[], name: string): string {
  for (const path of paths) {
    const dest = cloneDestBeside(path, name);
    if (dest) return dest;
  }
  return "";
}

/** 取上一级目录；盘符根与 `/` 保持原样（它们没有上一级）。 */
function parentOf(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes("\\") ? "\\" : "/";
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  // `C:` 这种情况去掉斜杠后只剩盘符，那一级就是盘根。
  if (/^[A-Za-z]:$/.test(withoutTrailing)) return `${withoutTrailing}\\`;
  const cut = withoutTrailing.lastIndexOf(separator);
  if (cut < 0) return null;
  if (cut === 0) return separator;
  return withoutTrailing.slice(0, cut);
}
