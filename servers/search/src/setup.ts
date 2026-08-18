import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { fetchPage, webSearch } from './tools.js';

/** 工具注册（stdio 与 HTTP 两种模式共用） */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'flowagent-search', version: '0.1.0' });

  server.registerTool(
    'web_search',
    {
      title: '网页搜索',
      description: '按关键词搜索网页，返回标题/链接/摘要（确定性假数据，离线可用）',
      inputSchema: {
        query: z.string().describe('搜索关键词'),
        limit: z.number().optional().describe('返回条数，默认 3'),
      },
    },
    async ({ query, limit }) => ({
      content: [{ type: 'text', text: JSON.stringify(webSearch(query, limit ?? 3), null, 2) }],
    }),
  );

  server.registerTool(
    'fetch_page',
    {
      title: '抓取页面',
      description: '按 URL 抓取页面正文（仅收录 demo 已知页面）',
      inputSchema: { url: z.string().describe('页面 URL') },
    },
    async ({ url }) => ({
      content: [{ type: 'text', text: fetchPage(url) }],
    }),
  );

  return server;
}
