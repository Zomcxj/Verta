import type { Ownership } from "@/lib/ownership";
import type { WireRemoteReposPayload } from "@/lib/native";

/** A remote repo as a UI row: the wire fields plus values computed in the UI. */
export type RemoteRepoRow = {
  fullName: string;
  owner: string;
  name: string;
  /** Whether this repository belongs to the signed-in account. */
  ownership: Ownership;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  language: string | null;
  /** Relative time label; null when GitHub gives no push time or one that cannot be parsed. */
  pushed: string | null;
  /** The raw push time behind `pushed`, so the column can sort by time rather than by the
   * label it shows. Null when GitHub gives nothing parseable. */
  pushedMs: number | null;
  description: string | null;
  webUrl: string;
  /** URL used by `git clone`. */
  cloneUrl: string;
};

export type RemoteReposKind = WireRemoteReposPayload["kind"];

/**
 * What to tell the user when the list is empty or unreadable; null when there is a
 * table to draw. The copy is an i18n key, and the tone picks the styling of the notice
 * block.
 */
export type RemotesNotice = {
  tone: "empty" | "warn" | "error";
  titleKey: string;
  hintKey: string;
  params?: Record<string, string | number>;
  /** gh's own words on failure; null when genuinely empty or empty after filtering. */
  detail: string | null;
};