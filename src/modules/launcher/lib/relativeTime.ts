const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ABSOLUTE_AFTER_DAYS = 30;

export function relativeTime(nowMs: number, updatedAtMs: number): string {
  if (!updatedAtMs || updatedAtMs <= 0) return "时间未知";
  const age = nowMs - updatedAtMs;
  // 时钟回拨或系统时间被改过时不显示负数。
  if (age < MINUTE) return "刚刚";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} 分钟前`;
  if (age < DAY) return `${Math.floor(age / HOUR)} 小时前`;
  const days = Math.floor(age / DAY);
  if (days < ABSOLUTE_AFTER_DAYS) return `${days} 天前`;
  const date = new Date(updatedAtMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
