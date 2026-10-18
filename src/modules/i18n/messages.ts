import type { Language } from "./language";

/**
 * The interface strings this fork owns: the session panel and the things added
 * beside it. Upstream text stays where it is until its module is translated,
 * because a half-moved module is worse to work on than an untranslated one.
 *
 * Keys are `module.name`, so a missing entry is obvious from the caller.
 */
const zh = {
  "rail.sessions": "会话",
  "rail.files": "文件",
  "rail.git": "Git",

  "launcher.manage": "管理",
  "launcher.done": "完成",
  "launcher.refresh": "刷新",
  "launcher.loading": "读取中",
  "launcher.search": "搜索标题或目录",
  "launcher.delete": "删除",
  "launcher.deleting": "删除中",
  "launcher.deleteConfirm": "删除会话",
  "launcher.deleteWarnOpencode": "删除 opencode 的父会话会连带删除它的子会话。",
  "launcher.deleteWarnPi": "删除 pi 会话时会连同该会话的产物目录一起删除。",
  "launcher.deleteWarnActive": "其中包含当前已在终端打开的会话。",
  "launcher.deleteIrreversible": "此操作不可撤销。",
  "launcher.cancel": "取消",
  "launcher.unknownReason": "未知原因",
  "launcher.clear": "清空",
  "launcher.selectAll": "全选",
  "launcher.selectedCount": "已选 {count} 条",
  "launcher.count": "{shown} / {total} 条",
  "launcher.countAll": "{total} 条",
  "launcher.unparsed": "，{count} 个文件无法解析",
  "launcher.deleteFailed": "有 {count} 条没能删除：\n{failures}",
  "launcher.deleteRequestFailed": "删除请求失败：{message}",
  "launcher.deleteTitle": "删除会话？",
  "launcher.deleteBody":
    "将从本机永久删除 {total} 条会话记录（opencode {opencode} 条、pi {pi} 条），无法撤销。",
  "launcher.deleteSubagents": "其中 {count} 条是子代理或分叉会话。",
  "launcher.failureLine": "{tool} {id}：{reason}",

  "settings.language": "界面语言",
  "settings.languageHint": "切换整个界面的语言，立即生效。",
  "settings.languageSystem": "跟随系统",
  "settings.languageActive": "当前显示：{language}",

  "preview.label": "预览",
  "preview.show": "显示预览",
  "preview.hide": "隐藏预览",
  "editor.showPreview": "显示预览",
  "editor.hidePreview": "隐藏预览",
} as const;

/** Keys the tables must all define. Typed from `zh`, the language of record. */
export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "rail.sessions": "Sessions",
  "rail.files": "Files",
  "rail.git": "Git",

  "launcher.manage": "Manage",
  "launcher.done": "Done",
  "launcher.refresh": "Refresh",
  "launcher.loading": "Reading",
  "launcher.search": "Search title or folder",
  "launcher.delete": "Delete",
  "launcher.deleting": "Deleting",
  "launcher.deleteConfirm": "Delete session",
  "launcher.deleteWarnOpencode":
    "Deleting an opencode parent session also deletes its child sessions.",
  "launcher.deleteWarnPi":
    "Deleting a pi session also deletes the artifacts folder that belongs to it.",
  "launcher.deleteWarnActive":
    "One of these is currently open in a terminal.",
  "launcher.deleteIrreversible": "This cannot be undone.",
  "launcher.cancel": "Cancel",
  "launcher.unknownReason": "unknown reason",
  "launcher.clear": "Clear",
  "launcher.selectAll": "Select all",
  "launcher.selectedCount": "{count} selected",
  "launcher.count": "{shown} / {total}",
  "launcher.countAll": "{total}",
  "launcher.unparsed": ", {count} unreadable files",
  "launcher.deleteFailed": "{count} could not be deleted:\n{failures}",
  "launcher.deleteRequestFailed": "Delete failed: {message}",
  "launcher.deleteTitle": "Delete session?",
  "launcher.deleteBody":
    "This permanently deletes {total} session records from this machine (opencode {opencode}, pi {pi}). It cannot be undone.",
  "launcher.deleteSubagents": "{count} of them are subagent or fork sessions.",
  "launcher.failureLine": "{tool} {id}: {reason}",

  "settings.language": "Interface language",
  "settings.languageHint": "Changes the language of the whole interface, immediately.",
  "settings.languageSystem": "Follow system",
  "settings.languageActive": "Currently showing: {language}",

  "preview.label": "Preview",
  "preview.show": "Show preview",
  "preview.hide": "Hide preview",
  "editor.showPreview": "Show preview",
  "editor.hidePreview": "Hide preview",
};

export const MESSAGES: Record<Language, Record<MessageKey, string>> = { zh, en };

/**
 * Looks up a message. Falls back to the key itself rather than throwing: a
 * missing string should show up as something obviously wrong in the UI, not
 * crash the pane it was meant to label.
 */
export function translate(
  language: Language,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const template = MESSAGES[language][key] ?? key;
  if (!values) return template;
  // `{name}` placeholders, so word order can differ between languages.
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
