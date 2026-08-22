/**
 * sandbox demo MCP Server 的代码执行实现。
 * 隔离红线：用户代码只在限额子进程内执行（限时/限长/输出截断），绝不在本进程 eval。
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

export function runJavascript(code: string, timeoutMs = 5_000): Promise<SandboxResult> {
  const startedAt = Date.now();
  return new Promise<SandboxResult>((resolve) => {
    execFile(
      process.execPath,
      ['-e', code],
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
}
