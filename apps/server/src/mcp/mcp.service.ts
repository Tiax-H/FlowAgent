import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { CreateMcpServerDto, McpServerResponseDto, McpToolResponseDto } from './dto/mcp.dto';
import { McpConnector } from './mcp.connector';
import { McpRegistryService } from './mcp.registry';

interface McpServerRow {
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
  createdAt: Date;
  updatedAt: Date;
}

interface McpToolRow {
  serverId: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: string;
}

@Injectable()
export class McpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: McpRegistryService,
    private readonly connector: McpConnector,
  ) {}

  async createServer(dto: CreateMcpServerDto): Promise<McpServerResponseDto> {
    if (typeof dto.name !== 'string' || dto.name.trim().length === 0) {
      throw new BadRequestException('name 必须为非空字符串');
    }
    if (!/^[a-z][a-z0-9_-]*$/i.test(dto.name)) {
      throw new BadRequestException('name 只允许字母数字与 _ -，且以字母开头');
    }

    const errors = this.connector.validateConfig({
      name: dto.name,
      transport: dto.transport,
      command: dto.command,
      args: dto.args,
      url: dto.url,
    });
    if (errors.length > 0) {
      throw new UnprocessableEntityException({ message: 'MCP Server 配置非法', errors });
    }

    const existing = await this.prisma.mcpServer.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException(`同名 Server 已存在: ${dto.name}`);

    const row = await this.prisma.mcpServer.create({
      data: {
        name: dto.name,
        transport: dto.transport,
        command: dto.command ?? null,
        args: dto.args ?? null,
        url: dto.url ?? null,
        enabled: dto.enabled ?? true,
      },
    });

    if (row.enabled) {
      await this.registry.connectServer(row.id).catch(() => undefined);
    }
    return this.findOne(row.id);
  }

  async listServers(): Promise<McpServerResponseDto[]> {
    const rows = await this.prisma.mcpServer.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tools: true } } },
    });
    return rows.map((row) => this.toServerResponse(row, row._count.tools));
  }

  async findOne(id: string): Promise<McpServerResponseDto> {
    const row = await this.prisma.mcpServer.findUnique({
      where: { id },
      include: { _count: { select: { tools: true } } },
    });
    if (!row) throw new NotFoundException(`MCP Server 不存在: ${id}`);
    return this.toServerResponse(row, row._count?.tools ?? 0);
  }

  async removeServer(id: string): Promise<void> {
    const row = await this.prisma.mcpServer.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`MCP Server 不存在: ${id}`);
    await this.registry.disconnectServer(id);
    await this.prisma.mcpServer.delete({ where: { id } });
  }

  async listTools(): Promise<McpToolResponseDto[]> {
    const rows = await this.prisma.mcpTool.findMany({
      include: { server: { select: { name: true } } },
      orderBy: [{ server: { name: 'asc' } }, { name: 'asc' }],
    });
    return rows.map((row) => this.toToolResponse(row, row.server.name));
  }

  async invokeTool(server: string, tool: string, args: Record<string, unknown> | undefined) {
    return this.registry.callTool(server, tool, args ?? {});
  }

  private toServerResponse(
    row: McpServerRow & { _count?: { tools: number } },
    toolCount?: number,
  ): McpServerResponseDto {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: row.url,
      enabled: row.enabled,
      status: row.status,
      statusMessage: row.statusMessage,
      lastConnectedAt: row.lastConnectedAt,
      toolCount: toolCount ?? row._count?.tools ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toToolResponse(row: McpToolRow, serverName: string): McpToolResponseDto {
    let inputSchema: unknown = {};
    try {
      inputSchema = JSON.parse(row.inputSchema) as unknown;
    } catch {
      inputSchema = {};
    }
    return {
      qualifiedName: `${serverName}:${row.name}`,
      serverId: row.serverId,
      serverName,
      name: row.name,
      title: row.title,
      description: row.description,
      inputSchema,
    };
  }
}
