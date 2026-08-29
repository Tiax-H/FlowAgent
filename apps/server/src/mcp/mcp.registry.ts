/**
 * MCP 工具注册表：连接池（内存）+ 注册表投影（落库）。
 *
 * 所有工具调用必须经由此服务路由（架构红线）：
 * `callTool(server, tool, args)` 是引擎/Tool 节点/调试面板的唯一入口。
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { DiscoveredTool, McpConnectionHandle } from './mcp.connector';
import { McpConnector } from './mcp.connector';

interface ManagedConnection {
  handle: McpConnectionHandle;
  /** list_changed 通知回调的清理函数 */
  cleanup: () => void;
}

/** 工具调用失败原因（HTTP 层据此映射状态码：not_found→404，not_connected/call_failed→502） */
export type McpCallFailureReason = 'server_not_found' | 'server_not_connected' | 'call_failed';

/**
 * 工具调用路由错误：message 为中文人话（可直接进事件流），
 * reason 供 controller/service 映射 HTTP 状态码，避免裸 500。
 */
export class McpToolCallError extends Error {
  constructor(
    message: string,
    public readonly reason: McpCallFailureReason,
    public readonly underlying?: unknown,
  ) {
    super(message);
    this.name = 'McpToolCallError';
  }
}

@Injectable()
export class McpRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(McpRegistryService.name);
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly connecting = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: McpConnector,
  ) {}

  /** 建立连接 → discovery → 注册表落库 → 更新状态 */
  async connectServer(serverId: string): Promise<void> {
    const existing = this.connecting.get(serverId);
    if (existing) return existing;

    const task = this.doConnect(serverId).finally(() => {
      this.connecting.delete(serverId);
    });
    this.connecting.set(serverId, task);
    return task;
  }

  private async doConnect(serverId: string): Promise<void> {
    const server = await this.prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!server) throw new Error(`MCP Server 不存在: ${serverId}`);
    if (!server.enabled) throw new Error(`MCP Server 已禁用: ${server.name}`);

    await this.disconnectServer(serverId);

    await this.prisma.mcpServer.update({
      where: { id: serverId },
      data: { status: 'connecting', statusMessage: null },
    });

    try {
      const connection = await this.connector.connect({
        name: server.name,
        transport: server.transport as 'stdio' | 'http',
        command: server.command ?? undefined,
        args: server.args ?? undefined,
        url: server.url ?? undefined,
      });

      const cleanup = this.watchListChanged(connection, serverId);
      this.connections.set(serverId, { handle: connection, cleanup });

      const tools = await this.connector.discoverTools(connection.client);
      await this.syncTools(serverId, tools);

      await this.prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'connected', statusMessage: null, lastConnectedAt: new Date() },
      });
      this.logger.log(`MCP Server "${server.name}" 已连接，注册 ${tools.length} 个工具`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`MCP Server "${server.name}" 连接失败: ${message}`);
      // 回滚：connect 成功但 discovery 失败时，摘除池内连接并关闭子进程，
      // 避免僵尸连接（DB 状态 error 但 callTool 仍按池路由）与 stdio 进程泄漏
      const managed = this.connections.get(serverId);
      if (managed) {
        this.connections.delete(serverId);
        managed.cleanup();
        await managed.handle.close().catch((closeError: unknown) => {
          this.logger.warn(`回滚关闭连接失败 (server=${serverId}): ${String(closeError)}`);
        });
      }
      await this.prisma.mcpServer.update({
        where: { id: serverId },
        data: { status: 'error', statusMessage: message },
      });
      throw error;
    }
  }

  /** 工具热更新：监听 list_changed 重新 discovery（对齐 2026-07-28 规范） */
  private watchListChanged(connection: McpConnectionHandle, serverId: string): () => void {
    return connection.onToolsChanged(() => {
      void this.refreshTools(serverId).catch((error: unknown) => {
        this.logger.warn(`工具热更新失败 (server=${serverId}): ${String(error)}`);
      });
    });
  }

  async refreshTools(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) throw new Error(`Server 未连接: ${serverId}`);
    const tools = await this.connector.discoverTools(connection.handle.client);
    await this.syncTools(serverId, tools);
  }

  /** 全量替换该 server 的注册表行（discovery 投影） */
  private async syncTools(serverId: string, tools: DiscoveredTool[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mcpTool.deleteMany({ where: { serverId } }),
      this.prisma.mcpTool.createMany({
        data: tools.map((tool) => ({
          serverId,
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          inputSchema: JSON.stringify(tool.inputSchema ?? {}),
        })),
      }),
    ]);
  }

  /** 断开连接并清理注册表投影 */
  async disconnectServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (connection) {
      this.connections.delete(serverId);
      connection.cleanup();
      await connection.handle.close().catch((error: unknown) => {
        this.logger.warn(`关闭连接失败 (server=${serverId}): ${String(error)}`);
      });
    }
    await this.prisma.mcpServer.update({
      where: { id: serverId },
      data: { status: 'disconnected' },
    });
    await this.prisma.mcpTool.deleteMany({ where: { serverId } });
  }

  /** 启动时恢复所有已启用的 server 连接 */
  async resumeEnabledServers(): Promise<void> {
    const servers = await this.prisma.mcpServer.findMany({ where: { enabled: true } });
    for (const server of servers) {
      void this.connectServer(server.id).catch(() => {
        // 状态已落库，启动失败不阻塞进程
      });
    }
  }

  /** 工具调用统一路由入口（失败一律抛 McpToolCallError，message 为中文） */
  async callTool(
    serverName: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result: unknown }> {
    const server = await this.prisma.mcpServer.findUnique({ where: { name: serverName } });
    if (!server) {
      throw new McpToolCallError(`Server “${serverName}” 不存在或未连接`, 'server_not_found');
    }

    const connection = this.connections.get(server.id);
    if (!connection) {
      throw new McpToolCallError(
        `Server “${serverName}” 未连接，请先在设置中重连后再调用`,
        'server_not_connected',
      );
    }

    try {
      return await this.connector.callTool(connection.handle.client, tool, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new McpToolCallError(`工具 “${tool}” 调用失败: ${message}`, 'call_failed', error);
    }
  }

  isServerConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  async onModuleDestroy(): Promise<void> {
    for (const serverId of [...this.connections.keys()]) {
      await this.disconnectServer(serverId).catch(() => undefined);
    }
  }
}
