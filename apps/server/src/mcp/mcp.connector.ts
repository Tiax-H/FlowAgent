/**
 * MCP 连接层：封装 @modelcontextprotocol/sdk Client 的建立与发现。
 *
 * 本周先落地 stdio 传输；http（Streamable HTTP）走同一入口，接口已预留。
 * 工具调用必须经过 McpRegistryService 的路由，不得绕过此层直连。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Injectable, Logger } from '@nestjs/common';

export interface DiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpConnectionConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string;
  url?: string;
}

export interface McpConnectionHandle {
  client: Client;
  /** 断开连接（杀掉子进程 / 关闭会话） */
  close: () => Promise<void>;
  /** 工具列表变更（list_changed）回调注册，返回清理函数 */
  onToolsChanged: (handler: () => void) => () => void;
}

/** stdio 命令白名单字符校验：防注入（命令来自用户配置，渲染与执行前必须校验） */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_@./:-]+$/;

@Injectable()
export class McpConnector {
  private readonly logger = new Logger(McpConnector.name);

  validateConfig(config: McpConnectionConfig): string[] {
    const errors: string[] = [];
    if (config.transport === 'stdio') {
      if (!config.command || config.command.trim().length === 0) {
        errors.push('stdio 传输必须提供 command');
      } else if (!SAFE_COMMAND_PATTERN.test(config.command)) {
        errors.push(`command 含非法字符: "${config.command}"（只允许字母数字与 _ @ . / : -）`);
      }
    } else if (config.transport === 'http') {
      if (!config.url) {
        errors.push('http 传输必须提供 url');
      } else {
        try {
          const parsed = new URL(config.url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push('url 只支持 http/https');
          }
        } catch {
          errors.push('url 格式非法');
        }
      }
    } else {
      errors.push(`未知传输类型: ${String(config.transport)}`);
    }
    return errors;
  }

  async connect(config: McpConnectionConfig): Promise<McpConnectionHandle> {
    const validationErrors = this.validateConfig(config);
    if (validationErrors.length > 0) {
      throw new Error(`MCP 连接配置非法: ${validationErrors.join('; ')}`);
    }

    const client = new Client({ name: `flowagent-gateway`, version: '0.1.0' });
    let close: () => Promise<void>;

    if (config.transport === 'stdio') {
      const args = (config.args ?? '')
        .split(' ')
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0);
      const transport = new StdioClientTransport({ command: config.command!, args });
      await client.connect(transport);
      close = async () => {
        await transport.close();
      };
    } else {
      // Streamable HTTP 传输：本周不实现，统一入口已预留
      throw new Error('Streamable HTTP 传输尚未支持（下一迭代落地）');
    }

    return {
      client,
      close,
      onToolsChanged: (handler: () => void) => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => handler());
        return () => {
          client.removeNotificationHandler('notifications/tools/list_changed');
        };
      },
    };
  }

  async discoverTools(client: Client): Promise<DiscoveredTool[]> {
    const result = await client.listTools();
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown,
    }));
  }

  async callTool(
    client: Client,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result: unknown }> {
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError) {
      return { ok: false, result: result.content };
    }
    return { ok: true, result: result.content };
  }
}
