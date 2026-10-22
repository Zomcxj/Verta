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

const MINUTE = 60_000;
const HOUR = 3_600_000;
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
 * 最后对话时间，由近到远：
 * `刚刚` → `N 分钟前` → `N 小时前`（1/3/6/12 各一档）→ `昨天` → `前天` → `2026-10-08`。
 *
 * 越近越要说清「多久以前」：一小时内说分钟，一天内说小时（取最接近的那一档），
 * 再往前才值得看日期 —— 那时「几号」比「几天前」好认。
 *
 * `nowMs` 与 `ms` 都按本地时间算日界；未来时间（时钟被改过）按「刚刚」说，不显示负数。
 */
export function lastTalkedDayLabel(nowMs: number, ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const elapsed = nowMs - ms;
  // 时钟漂移或未来时间：当作刚刚，不显示「-3 小时前」。
  if (elapsed < MINUTE) return "刚刚";

  const day = (value: number) => {
    const date = new Date(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const diffDays = Math.round((day(nowMs) - day(ms)) / DAY);

  // 今天之内：小时取最近的一档（1/2/3/6/12），让同一屏里的数字好比较。
  if (diffDays <= 0) {
    const hours = Math.floor(elapsed / HOUR);
    if (hours < 1) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
    return `${nearestHourStep(hours)} 小时前`;
  }
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "前天";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 小时数归到 1 / 3 / 6 / 12 这几档，避免出现「7 小时前」这种没人在意的精度。
 *
 * 取**最接近的那一档**（四舍五入），不是往上取整：2.9 小时说「3 小时前」没问题，
 * 但 5 小时说成「6 小时前」就夸张了 —— 5 离 6 最近，才算 6。
 */
function nearestHourStep(hours: number): number {
  // 档与档之间的分界在中点，各段按「离哪档近就说哪档」四舍五入。
  if (hours < 2) return 1;
  if (hours < 5) return 3;
  if (hours < 9) return 6;
  return 12;
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
