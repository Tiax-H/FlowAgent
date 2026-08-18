/**
 * search demo MCP Server 的确定性假数据实现（无外网依赖）。
 * 供 Gateway 联调与单测使用。
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const INDEX: Record<string, SearchHit[]> = {
  'mcp protocol': [
    {
      title: 'Model Context Protocol 官方规范',
      url: 'https://example.com/mcp-spec',
      snippet:
        'MCP 是面向 AI 应用的开放工具调用协议，2026-07-28 版引入 stateless discovery 与 Tasks。',
    },
    {
      title: 'MCP 生态 Server 目录',
      url: 'https://example.com/mcp-servers',
      snippet: '数百个现成 MCP Server：文件系统、搜索、代码沙箱、数据库等。',
    },
  ],
  'durable execution': [
    {
      title: 'Durable Execution: Temporal 模式解析',
      url: 'https://example.com/durable-execution',
      snippet: '事件溯源 + checkpoint + 断点恢复，把长任务的可靠性从会话中解放出来。',
    },
    {
      title: 'Restate 与 Agent 工作流',
      url: 'https://example.com/restate-agents',
      snippet: 'Agent 编排场景下的持久化执行实践。',
    },
  ],
};

const ALL_HITS: SearchHit[] = Object.values(INDEX).flat();

export function webSearch(query: string, limit = 3): SearchHit[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const matched = ALL_HITS.filter(
    (hit) =>
      hit.title.toLowerCase().includes(normalized) ||
      hit.snippet.toLowerCase().includes(normalized) ||
      normalized
        .split(/\s+/)
        .some((word) => word.length > 0 && hit.snippet.toLowerCase().includes(word)),
  );
  return matched.slice(0, limit);
}

export function fetchPage(url: string): string {
  const hit = ALL_HITS.find((item) => item.url === url);
  if (!hit) {
    return `(404) 未收录页面: ${url}。本 demo Server 只收录 ${ALL_HITS.length} 个确定性页面。`;
  }
  return `# ${hit.title}\n\n来源: ${hit.url}\n\n${hit.snippet}\n\n[本页面为 demo 假数据，用于离线联调]`;
}
