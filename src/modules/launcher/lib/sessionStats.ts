/**
 * 会话列表那一行上的三个数字：轮数、tokens、最后对话时间（到日）。
 *
 * 后端取不到某项时给的是 `null`（不是 0）—— 界面上要显示「—」，不能用 0 冒充，
 * 那会让人以为这个会话一句话都没说过。
 */

export type SessionStats = {
  turns: number | null;
  tokens: number | null;
  /** 最后一次**对话**的时间；没有就退回文件更新时间（`updatedAtMs`）。 */
  lastAtMs: number | null;
};

const DAY = 86_400_000;

/** 轮数：`12 轮`；不知道就是 `—`。 */
export function turnsLabel(turns: number | null | undefined): string {
  if (turns === null || turns === undefined || turns < 0) return "—";
  return `${turns} 轮`;
}

/**
 * tokens：一万以内照写，一万以上折成 `12.3 万`，百万以上 `1.2 M`。
 *
 * 会话动辄几十万 tokens，原样写一长串没人读得出来量级。
 */
export function tokensLabel(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || tokens < 0) return "—";
  if (tokens < 10_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) {
    const wan = tokens / 10_000;
    return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)} 万 tokens`;
  }
  const million = tokens / 1_000_000;
  return `${million >= 100 ? Math.round(million) : million.toFixed(1)} M tokens`;
}

/**
 * 最后对话时间，精确到日：今天 / 昨天 / `2026-10-08`。
 *
 * `nowMs` 与 `ms` 都按本地时间算日界；未来时间（时钟被改过）按今天说，不显示负数。
 */
export function lastTalkedDayLabel(nowMs: number, ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const day = (value: number) => {
    const date = new Date(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const diffDays = Math.round((day(nowMs) - day(ms)) / DAY);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 后端给的统计 + 兜底：没有对话时间就用更新时间，别的不知道就留空。 */
export function statsOf(session: {
  turns?: number | null;
  tokens?: number | null;
  lastAtMs?: number | null;
  updatedAtMs: number;
}): SessionStats {
  return {
    turns: session.turns ?? null,
    tokens: session.tokens ?? null,
    lastAtMs: session.lastAtMs ?? session.updatedAtMs ?? null,
  };
}
