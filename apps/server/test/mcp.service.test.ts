import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { McpConnector } from '../src/mcp/mcp.connector';
import { McpRegistryService } from '../src/mcp/mcp.registry';
import { McpService } from '../src/mcp/mcp.service';

type ServerRow = {
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
};

type ToolRow = {
  id: string;
  serverId: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: string;
  discoveredAt: Date;
};

function makeRow(overrides: Partial<ServerRow> = {}): ServerRow {
  const now = new Date();
  return {
    id: `srv_${overrides.name ?? 'x'}`,
    name: 'search',
    transport: 'stdio',
    command: 'node',
    args: null,
    url: null,
    enabled: true,
    status: 'disconnected',
    statusMessage: null,
    lastConnectedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePrismaStub(servers: ServerRow[], tools: ToolRow[]) {
  return {
    mcpServer: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; name?: string } }) => {
        if (where.id) return servers.find((row) => row.id === where.id) ?? null;
        return servers.find((row) => row.name === where.name) ?? null;
      }),
      findMany: vi.fn(async () => servers),
      create: vi.fn(async ({ data }: { data: Partial<ServerRow> }) => {
        const row = makeRow({ ...data, id: `srv_${data.name}` } as Partial<ServerRow>);
        servers.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ServerRow> }) => {
          const row = servers.find((item) => item.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = servers.findIndex((item) => item.id === where.id);
        if (index === -1) throw new Error('not found');
        return servers.splice(index, 1)[0]!;
      }),
    },
    mcpTool: {
      findMany: vi.fn(async () =>
        tools.map((tool) => ({ ...tool, server: servers.find((s) => s.id === tool.serverId)! })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { serverId: string } }) => {
        const before = tools.length;
        for (let i = tools.length - 1; i >= 0; i -= 1) {
          if (tools[i]!.serverId === where.serverId) tools.splice(i, 1);
        }
        return { count: before - tools.length };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Partial<ToolRow>> }) => {
        for (const item of data) {
          tools.push({
            id: `tool_${item.serverId}_${item.name}`,
            serverId: item.serverId!,
            name: item.name!,
            title: item.title ?? null,
            description: item.description ?? null,
            inputSchema: item.inputSchema!,
            discoveredAt: new Date(),
          });
        }
        return { count: data.length };
      }),
    },
    $transaction: vi.fn(async (operations: unknown[]) =>
      Promise.all(operations as Promise<unknown>[]),
    ),
  } as unknown as PrismaService;
}

function makeRegistryStub() {
  return {
    connectServer: vi.fn(async () => undefined),
    disconnectServer: vi.fn(async () => undefined),
    callTool: vi.fn(async () => ({ ok: true, result: 'ok' })),
    resumeEnabledServers: vi.fn(async () => undefined),
  } as unknown as McpRegistryService;
}

async function createService(prismaStub: PrismaService, registryStub: McpRegistryService) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: PrismaService, useValue: prismaStub },
      { provide: McpRegistryService, useValue: registryStub },
      McpConnector,
      McpService,
    ],
  }).compile();
  return moduleRef.get(McpService);
}

describe('McpService', () => {
  let servers: ServerRow[];
  let tools: ToolRow[];
  let prisma: PrismaService;
  let registry: McpRegistryService;
  let service: McpService;

  beforeEach(async () => {
    servers = [];
    tools = [];
    prisma = makePrismaStub(servers, tools);
    registry = makeRegistryStub();
    service = await createService(prisma, registry);
  });

  it('创建合法 stdio server 并触发连接', async () => {
    const created = await service.createServer({
      name: 'search',
      transport: 'stdio',
      command: 'node',
      args: 'servers/search/dist/index.js',
    });
    expect(created.name).toBe('search');
    expect(created.status).toBe('disconnected');
    expect(registry.connectServer).toHaveBeenCalledWith(created.id);
  });

  it('name 非法字符被拒绝', async () => {
    await expect(
      service.createServer({ name: 'bad name!', transport: 'stdio', command: 'node' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stdio 缺 command 抛 422', async () => {
    await expect(
      service.createServer({ name: 'search', transport: 'stdio' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('command 含 shell 元字符被拒绝（注入防护）', async () => {
    try {
      await service.createServer({ name: 'evil', transport: 'stdio', command: 'sh; rm -rf /' });
      expect.unreachable('应当拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const response = (error as UnprocessableEntityException).getResponse() as {
        errors: string[];
      };
      expect(response.errors.some((message) => message.includes('非法字符'))).toBe(true);
    }
  });

  it('同名 server 抛 Conflict', async () => {
    servers.push(makeRow({ id: 'srv_search', name: 'search' }));
    await expect(
      service.createServer({ name: 'search', transport: 'stdio', command: 'node' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('removeServer 先断开再删除', async () => {
    servers.push(makeRow({ id: 'srv_search', name: 'search' }));
    await service.removeServer('srv_search');
    expect(registry.disconnectServer).toHaveBeenCalledWith('srv_search');
    expect(servers).toHaveLength(0);
  });

  it('removeServer 不存在抛 NotFound', async () => {
    await expect(service.removeServer('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listTools 输出带命名空间的全限定名', async () => {
    servers.push(makeRow({ id: 'srv_search', name: 'search' }));
    tools.push({
      id: 't1',
      serverId: 'srv_search',
      name: 'web_search',
      title: '网页搜索',
      description: null,
      inputSchema: '{"type":"object"}',
      discoveredAt: new Date(),
    });
    const list = await service.listTools();
    expect(list).toHaveLength(1);
    expect(list[0]?.qualifiedName).toBe('search:web_search');
    expect(list[0]?.inputSchema).toEqual({ type: 'object' });
  });

  it('invokeTool 走 registry 路由', async () => {
    await service.invokeTool('search', 'web_search', { query: 'mcp' });
    expect(registry.callTool).toHaveBeenCalledWith('search', 'web_search', { query: 'mcp' });
  });
});

describe('McpConnector.validateConfig', () => {
  const connector = new McpConnector();

  it('合法 stdio 配置通过', () => {
    expect(
      connector.validateConfig({ name: 's', transport: 'stdio', command: 'node', args: 'a.js' }),
    ).toEqual([]);
  });

  it('http url 非法格式被拒', () => {
    const errors = connector.validateConfig({ name: 's', transport: 'http', url: 'not-a-url' });
    expect(errors.some((message) => message.includes('url'))).toBe(true);
  });

  it('ftp 协议被拒', () => {
    const errors = connector.validateConfig({ name: 's', transport: 'http', url: 'ftp://x.com' });
    expect(errors.some((message) => message.includes('http/https'))).toBe(true);
  });

  it('未知传输被拒', () => {
    expect(connector.validateConfig({ name: 's', transport: 'ws' as 'stdio' })).not.toHaveLength(0);
  });
});
