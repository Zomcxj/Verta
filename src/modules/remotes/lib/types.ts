import type { WireRemoteReposPayload } from "@/lib/native";

/** 界面上一行远程仓库：wire 字段之外，加上界面自己算出来的两项。 */
export type RemoteRepoRow = {
  fullName: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  language: string | null;
  /** 相对时间文案；GitHub 没给推送时间、或给了个解不出来的值时是 null。 */
  pushed: string | null;
  description: string | null;
  webUrl: string;
  /** `git clone` 用的地址。 */
  cloneUrl: string;
};

export type RemoteReposKind = WireRemoteReposPayload["kind"];

/**
 * 列表为空或读不到时界面上该说什么，有内容要画表格时是 null。
 * 文案是 i18n 键，色调决定提示块的样子。
 */
export type RemotesNotice = {
  tone: "empty" | "warn" | "error";
  titleKey: string;
  hintKey: string;
  params?: Record<string, string | number>;
  /** 失败时 gh 的原话；真空态与筛空时为 null。 */
  detail: string | null;
};