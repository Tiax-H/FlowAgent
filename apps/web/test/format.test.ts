import { describe, expect, it } from 'vitest';

import { formatDuration, formatEventTime, shortenText } from '../src/lib/format';

describe('formatEventTime', () => {
  const now = new Date('2026-08-29T14:03:11');

  it('同一天只显示时分秒', () => {
    expect(formatEventTime('2026-08-29T14:03:11', now)).toBe('14:03:11');
  });

  it('跨天补充月-日', () => {
    expect(formatEventTime('2026-08-28T09:00:00', now)).toBe('08-28 09:00:00');
  });

  it('非法时间戳返回占位符', () => {
    expect(formatEventTime('not-a-date', now)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('毫秒级显示毫秒', () => {
    expect(formatDuration(850)).toBe('850 毫秒');
  });

  it('秒级保留一位小数', () => {
    expect(formatDuration(3200)).toBe('3.2 秒');
  });

  it('分钟与小时组合', () => {
    expect(formatDuration(125_000)).toBe('2 分 5 秒');
    expect(formatDuration(3_753_000)).toBe('1 小时 2 分 33 秒');
  });

  it('非法输入返回占位符', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('shortenText', () => {
  it('短文本原样返回', () => {
    expect(shortenText('abc', 5)).toBe('abc');
  });

  it('超长截断并追加省略号', () => {
    expect(shortenText('abcdef', 5)).toBe('abcde…');
  });
});
