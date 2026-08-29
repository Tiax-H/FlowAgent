/** 统一的展示格式化工具：时间轴时间、运行耗时、长文本截断 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 时间轴时间戳：与「现在」同一天只显示时分秒（14:03:11），
 * 跨天补充月-日（08-29 14:03:11），避免长跑 run 里分不清事件属于哪天。
 */
export function formatEventTime(timestamp: string | number, now: Date = new Date()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return clock;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** 运行耗时：毫秒 → 中文短句（如「850 毫秒」「3.2 秒」「2 分 5 秒」「1 小时 2 分 3 秒」） */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${rest} 秒`;
  return `${minutes} 分 ${rest} 秒`;
}

/** 长文本截断：超过 max 字符时截断并追加省略号 */
export function shortenText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
