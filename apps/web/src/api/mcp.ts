export interface McpServer {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  url: string | null;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  lastConnectedAt: string | null;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpTool {
  qualifiedName: string;
  serverId: string;
  serverName: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error('无法连接服务器，请确认 server 已启动（pnpm dev）');
    }
    throw cause;
  }
  if (!response.ok) {
    // 后端 JSON body 上限 1MB：413 统一映射为中文提示，不透出裸状态码
    if (response.status === 413) {
      throw new Error('输入内容超过 1MB 上限，请精简后重试');
    }
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const mcpApi = {
  listServers: () => request<McpServer[]>('/api/mcp/servers'),
  createServer: (body: {
    name: string;
    transport: 'stdio' | 'http';
    command?: string;
    args?: string;
    url?: string;
  }) => request<McpServer>('/api/mcp/servers', { method: 'POST', body: JSON.stringify(body) }),
  removeServer: (id: string) => request<void>(`/api/mcp/servers/${id}`, { method: 'DELETE' }),
  reconnectServer: (id: string) =>
    request<McpServer>(`/api/mcp/servers/${id}/reconnect`, { method: 'PATCH' }),
  listTools: () => request<McpTool[]>('/api/mcp/tools'),
  invokeTool: (server: string, tool: string, args: Record<string, unknown>) =>
    request<{ ok: boolean; result: unknown }>('/api/mcp/tools/invoke', {
      method: 'POST',
      body: JSON.stringify({ server, tool, args }),
    }),
};
