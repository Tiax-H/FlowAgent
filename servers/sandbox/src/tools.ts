/**
 * sandbox demo MCP Server 的代码执行实现。
 * 隔离红线：用户代码只在限额子进程内执行（限时/限长/限内存/限并发/输出截断），绝不在本进程 eval。
 * 已知限制（demo 定位，非安全沙箱）：无文件系统/网络隔离，孙进程不在超时击杀范围。
 */
import { execFile } from 'node:child_process';

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

const MAX_CODE_LENGTH = 10_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_BUFFER_BYTES = 64 * 1024;
/** 子进程内存上限（V8 堆），防 5 秒内分配数 GB 内存 */
const MAX_OLD_SPACE_MB = 256;
/** 全局并发上限：防无限并发 spawn 完整 Node 进程耗尽宿主资源 */
const MAX_CONCURRENCY = 2;

let activeCount = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENCY) {
    activeCount += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCount += 1;
}

function releaseSlot(): void {
  activeCount -= 1;
  const next = waiters.shift();
  if (next) next();
}

export function validateCode(code: string): string | null {
  if (code.trim().length === 0) return 'code 不能为空';
  if (code.length > MAX_CODE_LENGTH) {
    return `code 长度超限（${code.length} > ${MAX_CODE_LENGTH}）`;
  }
  return null;
}

export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(输出已截断)`, truncated: true };
}

export async function runJavascript(code: string, timeoutMs = 5_000): Promise<SandboxResult> {
  if (activeCount >= MAX_CONCURRENCY) {
    return {
      ok: false,
      stdout: '',
      stderr: `并发超限：sandbox 最多同时执行 ${MAX_CONCURRENCY} 段代码，请稍后重试`,
      durationMs: 0,
      timedOut: false,
      truncated: false,
    };
  }
  await acquireSlot();
  try {
    return await new Promise<SandboxResult>((resolve) => {
      const startedAt = Date.now();
      execFile(
        process.execPath,
        [`--max-old-space-size=${MAX_OLD_SPACE_MB}`, '-e', code],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, shell: false },
        (error, stdout, stderr) => {
          const timedOut =
            (error as (NodeJS.ErrnoException & { killed?: boolean }) | null)?.killed === true;
          const out = truncateOutput(String(stdout));
          const err = truncateOutput(String(stderr));
          resolve({
            ok: error === null,
            stdout: out.text,
            stderr: err.text,
            durationMs: Date.now() - startedAt,
            timedOut,
            truncated: out.truncated || err.truncated,
          });
        },
      );
    });
  } finally {
    releaseSlot();
  }
}
