export interface CreateMcpServerDto {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio 必填：可执行命令 */
  command?: string;
  /** stdio 可选：空格分隔的参数串 */
  args?: string;
  /** http 必填：Streamable HTTP 端点 */
  url?: string;
  enabled?: boolean;
}

export interface McpServerResponseDto {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  url: string | null;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  lastConnectedAt: Date | null;
  toolCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpToolResponseDto {
  /** 全局限名：`<server>:<tool>` */
  qualifiedName: string;
  serverId: string;
  serverName: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
}

export interface InvokeToolDto {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface InvokeToolResponseDto {
  ok: boolean;
  result: unknown;
}
