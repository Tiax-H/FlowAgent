/**
 * 事件 payload 截断：LLM/工具的全文输出是事件流的字节乘数，
 * 超限值入事件前替换为带预览的占位（内存中的完整输出不受影响）。
 *
 * 已知权衡（记录于 docs/DURABLE_EXECUTION.md）：崩溃恢复后从事件重建的
 * nodeOutputs 是截断值；64KB 上限让该情形在实践中极少出现。
 */
const MAX_EVENT_VALUE_CHARS = 64 * 1024;

export function truncateForEvent<T>(value: T): T | { truncated: true; preview: string } {
  if (typeof value === 'string') {
    if (value.length <= MAX_EVENT_VALUE_CHARS) return value;
    return { truncated: true, preview: value.slice(0, MAX_EVENT_VALUE_CHARS) };
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return { truncated: true, preview: '' };
  }
  if (serialized.length <= MAX_EVENT_VALUE_CHARS) return value;
  return { truncated: true, preview: serialized.slice(0, MAX_EVENT_VALUE_CHARS) };
}
