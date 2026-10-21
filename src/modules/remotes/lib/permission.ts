import type { WireRepoPermissionPayload } from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";

/**
 * 写操作按钮在不在。
 *
 * **没查出来、以及查不动（没装 gh / 没登录 / 出错了）都返回 true**：按钮照常渲染，点下去由
 * GitHub 拒绝并把原话透传出来。反过来把按钮藏了，一个本来能操作的用户就彻底没入口了，
 * 而且他看不出是「没权限」还是「查不到」。
 */
export function canWrite(payload: WireRepoPermissionPayload | null): boolean {
  return payload ? payload.canWrite : true;
}

/**
 * 「这个仓库你只能读」那句话的键；没有这句话时是 null。
 *
 * 只有后端**确认**了只读才提示：查不动时不提示 —— 那时候按钮还在，提示反而让人以为点不动。
 */
export function readOnlyHintKey(
  payload: WireRepoPermissionPayload | null,
): MessageKey | null {
  if (payload?.kind !== "ready") return null;
  return payload.canWrite ? null : "remotes.permission.readOnly";
}
