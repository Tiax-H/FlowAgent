import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  formatCitations,
  generateMarkdownReport,
  validateCitations,
  validateReportInput,
  type CitationSource,
  type ReportInput,
} from './tools.js';

/** 工具注册（stdio 与 HTTP 两种模式共用） */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'flowagent-report', version: '0.1.0' });

  server.registerTool(
    'generate_report',
    {
      title: '生成报告',
      description: '把结构化章节渲染为 Markdown 报告（标题 + 元数据表 + 章节正文）',
      inputSchema: {
        title: z.string().describe('报告标题'),
        sections: z
          .array(z.object({ heading: z.string(), body: z.string() }))
          .min(1)
          .describe('章节列表'),
        metadata: z.record(z.string(), z.string()).optional().describe('元数据键值表'),
      },
    },
    async ({ title, sections, metadata }) => {
      const input: ReportInput = { title, sections, metadata };
      const invalid = validateReportInput(input);
      if (invalid) throw new Error(invalid);
      return { content: [{ type: 'text', text: generateMarkdownReport(input) }] };
    },
  );

  server.registerTool(
    'format_citations',
    {
      title: '格式化引用',
      description: '把来源列表格式化为 Markdown 引用清单（编号 + 标题 + URL）',
      inputSchema: {
        sources: z
          .array(z.object({ title: z.string(), url: z.string() }))
          .min(1)
          .describe('来源列表'),
      },
    },
    async ({ sources }) => {
      const typed: CitationSource[] = sources;
      const invalid = validateCitations(typed);
      if (invalid) throw new Error(invalid);
      return { content: [{ type: 'text', text: formatCitations(typed) }] };
    },
  );

  return server;
}
