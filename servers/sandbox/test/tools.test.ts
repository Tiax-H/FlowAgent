import { describe, expect, it } from 'vitest';

import { runJavascript, truncateOutput, validateCode } from '../src/tools';

describe('validateCode', () => {
  it('空代码被拒', () => {
    expect(validateCode('   ')).toContain('不能为空');
  });

  it('超长代码被拒', () => {
    expect(validateCode('a'.repeat(10_001))).toContain('超限');
  });

  it('合法代码通过', () => {
    expect(validateCode('console.log(1)')).toBeNull();
  });
});

describe('truncateOutput', () => {
  it('短文本原样返回', () => {
    expect(truncateOutput('abc')).toEqual({ text: 'abc', truncated: false });
  });

  it('超长文本截断并标记', () => {
    const result = truncateOutput('a'.repeat(9_000));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(9_000);
    expect(result.text).toContain('截断');
  });
});

describe('runJavascript', () => {
  it('执行成功并收集 stdout', async () => {
    const result = await runJavascript("console.log('你好', 1 + 1)");
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('你好 2');
    expect(result.timedOut).toBe(false);
  });

  it('异常退出时 ok=false 且带 stderr', async () => {
    const result = await runJavascript('throw new Error("boom")');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('boom');
  });

  it('超时被杀', async () => {
    const result = await runJavascript('while (true) {}', 300);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe('sandbox 并发限额（2026-08-22 复审新增）', () => {
  it('超过并发上限的调用立即返回明确错误而非无限排队', async () => {
    const slow = 'await new Promise((resolve) => setTimeout(resolve, 400)); "done"';
    // 前两个占满并发额度，第三个应被拒
    const [first, second, third] = await Promise.all([
      runJavascript(slow, 3000),
      runJavascript(slow, 3000),
      runJavascript(slow, 3000),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    expect(third.stderr).toContain('并发超限');
  });
});
