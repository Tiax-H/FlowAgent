import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { runJavascript, validateCode } from './tools.js';

/** 工具注册（stdio 与 HTTP 两种模式共用） */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'flowagent-sandbox', version: '0.1.0' });

  server.registerTool(
    'run_javascript',
    {
      title: '运行 JavaScript',
      description:
        '在限额子进程内执行一段 JavaScript（隔离执行：限时/限长/输出截断），返回 stdout/stderr/耗时',
      inputSchema: {
        code: z.string().describe('要执行的 JavaScript 源码'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(15_000)
          .optional()
          .describe('执行超时毫秒，默认 5000，上限 15000'),
      },
    },
    async ({ code, timeoutMs }) => {
      const invalid = validateCode(code);
      if (invalid) throw new Error(invalid);
      const result = await runJavascript(code, timeoutMs ?? 5_000);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}
