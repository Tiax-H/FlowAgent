import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  mergeProviderConfigs,
  parseProviderConfigs,
  LlmProviderError,
  type ProviderTestOutcome,
} from '../src/llm/llm.adapter';
import { LlmAdapter } from '../src/llm/llm.adapter';
import { LlmProviderController } from '../src/llm/llm-provider.controller';
import { ProviderConfigService, type ProviderConfigRow } from '../src/llm/provider-config.service';
import { encryptSecret, decryptSecret, SECRET_KEY_ENV } from '../src/llm/provider-crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const MASTER_KEY = 'unit-test-master-key-0123456789abcdef';
const ENV_OPENAI_KEY = 'sk-env-openai-secret';
const DB_KEY = 'sk-db-plain-secret';

/** 最小 fetch 响应桩：adapter 只消费 ok/status/text()/json() */
function fakeResponse(status: number, body: string) {
  return {
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

/** providerConfig 模型的内存桩（行为对齐 Prisma 单表 CRUD） */
function makePrismaStub(rows: ProviderConfigRow[] = []) {
  return {
    providerConfig: {
      findMany: vi.fn(async () => rows.map((row) => ({ ...row }))),
      findUnique: vi.fn(
        async ({ where }: { where: { name: string } }) =>
          rows.find((row) => row.name === where.name) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: Omit<ProviderConfigRow, 'createdAt' | 'updatedAt'> }) => {
          const now = new Date();
          const row: ProviderConfigRow = { ...data, createdAt: now, updatedAt: now };
          rows.push(row);
          return { ...row };
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { name: string }; data: Partial<ProviderConfigRow> }) => {
          const row = rows.find((item) => item.name === where.name);
          if (!row) throw new Error('record not found');
          Object.assign(row, data, { updatedAt: new Date() });
          return { ...row };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { name: string } }) => {
        const index = rows.findIndex((item) => item.name === where.name);
        if (index === -1) throw new Error('record not found');
        const [row] = rows.splice(index, 1);
        return row;
      }),
    },
  };
}

function makeRow(overrides: Partial<ProviderConfigRow> = {}): ProviderConfigRow {
  const now = new Date();
  return {
    name: 'dbprov',
    baseURL: 'https://db.example.com/v1',
    apiKeyEncrypted: encryptSecret(DB_KEY, { [SECRET_KEY_ENV]: MASTER_KEY }),
    models: 'd-1, d-2',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 完整栈：env 桩 + 内存 Prisma 桩 + 合并 resolver 的适配器 + 控制器 */
function makeStack(rows: ProviderConfigRow[] = []): {
  controller: LlmProviderController;
  service: ProviderConfigService;
  adapter: LlmAdapter;
  rows: ProviderConfigRow[];
} {
  const service = new ProviderConfigService(makePrismaStub(rows) as unknown as PrismaService);
  const adapter = new LlmAdapter(() =>
    mergeProviderConfigs(parseProviderConfigs(process.env), service.getSnapshot()),
  );
  const controller = new LlmProviderController(adapter, service);
  return { controller, service, adapter, rows };
}

describe('LlmProviderController GET providers（env + 数据库合并列表）', () => {
  beforeEach(() => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_ALPHA__BASEURL', 'https://a.example.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_ALPHA__APIKEY', 'sk-alpha-env');
    vi.stubEnv('FLOWAGENT_PROVIDERS_ALPHA__MODELS', 'a-1, a-2');
    vi.stubEnv('FLOWAGENT_PROVIDERS_BETA__BASEURL', 'https://b.example.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_BETA__APIKEY', 'sk-beta-env');
    vi.stubEnv('FLOWAGENT_PROVIDERS_BETA__MODELS', 'b-1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('返回 { configurable, providers }：env 与 db 条目按名称排序，db 条目含 baseURL/last4/updatedAt，env 条目不含', async () => {
    const { controller } = makeStack([makeRow()]);
    const response = await controller.listProviders();
    expect(response.configurable).toBe(true);
    expect(response.providers).toEqual([
      { name: 'alpha', models: ['a-1', 'a-2'], source: 'env' },
      { name: 'beta', models: ['b-1'], source: 'env' },
      {
        name: 'dbprov',
        models: ['d-1', 'd-2'],
        source: 'db',
        baseURL: 'https://db.example.com/v1',
        apiKeyLast4: 'cret',
        updatedAt: expect.any(String),
      },
    ]);
  });

  it('响应体任何位置不含明文密钥与密文字段名；baseURL 仅 db 条目返回（env 条目的 baseURL 不出现）', async () => {
    const { controller } = makeStack([makeRow()]);
    const serialized = JSON.stringify(await controller.listProviders());
    expect(serialized).not.toContain('sk-alpha-env');
    expect(serialized).not.toContain('sk-beta-env');
    expect(serialized).not.toContain(DB_KEY);
    expect(serialized).not.toContain('apiKeyEncrypted');
    // env 条目不返回 baseURL（env 端点可在 .env 里自行查看）
    expect(serialized).not.toContain('a.example.com');
    // db 条目返回 baseURL（非机密，供编辑预填）
    expect(serialized).toContain('https://db.example.com/v1');
  });

  it('未设置 FLOWAGENT_SECRET_KEY → configurable: false，列表仅含 env 条目', async () => {
    delete process.env[SECRET_KEY_ENV];
    const { controller } = makeStack();
    const response = await controller.listProviders();
    expect(response.configurable).toBe(false);
    expect(response.providers).toEqual([
      { name: 'alpha', models: ['a-1', 'a-2'], source: 'env' },
      { name: 'beta', models: ['b-1'], source: 'env' },
    ]);
  });

  it('无任何 Provider 配置时返回空列表（configurable 跟随密钥开关）', async () => {
    vi.stubEnv('FLOWAGENT_PROVIDERS_ALPHA__BASEURL', '');
    vi.stubEnv('FLOWAGENT_PROVIDERS_BETA__BASEURL', '');
    const { controller } = makeStack();
    expect(await controller.listProviders()).toEqual({ configurable: true, providers: [] });
  });
});

describe('LlmProviderController POST providers（网页端创建）', () => {
  beforeEach(() => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__BASEURL', 'https://api.openai.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__APIKEY', ENV_OPENAI_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__MODELS', 'gpt-4o');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('合法请求 → { name }；落库为密文（不含明文），baseURL/models 归一化', async () => {
    const { controller, rows } = makeStack();
    await expect(
      controller.createProvider({
        name: 'webprov',
        baseURL: 'https://web.example.com/v1/',
        apiKey: `  ${DB_KEY}  `,
        models: 'w-1, ,w-2,',
      }),
    ).resolves.toEqual({ name: 'webprov' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('webprov');
    expect(rows[0]?.baseURL).toBe('https://web.example.com/v1');
    expect(rows[0]?.models).toBe('w-1,w-2');
    expect(rows[0]?.apiKeyEncrypted.startsWith('v1:')).toBe(true);
    expect(rows[0]?.apiKeyEncrypted).not.toContain(DB_KEY);
    expect(decryptSecret(rows[0]?.apiKeyEncrypted ?? '', process.env)).toBe(DB_KEY);
  });

  it('创建响应不含明文密钥', async () => {
    const { controller } = makeStack();
    const response = await controller.createProvider({
      name: 'webprov',
      baseURL: 'https://web.example.com/v1',
      apiKey: DB_KEY,
      models: 'w-1',
    });
    expect(JSON.stringify(response)).not.toContain(DB_KEY);
  });

  it.each([
    [
      '名称大写',
      { name: 'WebProv', baseURL: 'https://w.example.com/v1', apiKey: DB_KEY, models: 'w-1' },
    ],
    [
      '名称以中划线开头',
      { name: '-web', baseURL: 'https://w.example.com/v1', apiKey: DB_KEY, models: 'w-1' },
    ],
    [
      '名称超长',
      { name: 'a'.repeat(33), baseURL: 'https://w.example.com/v1', apiKey: DB_KEY, models: 'w-1' },
    ],
    ['baseURL 非法', { name: 'webprov', baseURL: 'not a url', apiKey: DB_KEY, models: 'w-1' }],
    [
      'baseURL 非 http(s)',
      { name: 'webprov', baseURL: 'ftp://w.example.com', apiKey: DB_KEY, models: 'w-1' },
    ],
    [
      'apiKey 空',
      { name: 'webprov', baseURL: 'https://w.example.com/v1', apiKey: '   ', models: 'w-1' },
    ],
    [
      'models 空',
      { name: 'webprov', baseURL: 'https://w.example.com/v1', apiKey: DB_KEY, models: ' , ,' },
    ],
    [
      'models 非字符串',
      { name: 'webprov', baseURL: 'https://w.example.com/v1', apiKey: DB_KEY, models: 42 },
    ],
  ])('非法请求（%s）→ 400 中文', async (_label, body) => {
    const { controller, rows } = makeStack();
    await expect(controller.createProvider(body)).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('与环境变量同名 → 409「与环境变量配置同名，请直接修改环境变量」', async () => {
    const { controller, rows } = makeStack();
    await expect(
      controller.createProvider({
        name: 'openai',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toThrow('与环境变量配置同名，请直接修改环境变量');
    await expect(
      controller.createProvider({
        name: 'openai',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows).toHaveLength(0);
  });

  it('与已有网页配置同名 → 409「已存在同名网页配置」', async () => {
    const { controller, rows } = makeStack([makeRow()]);
    await expect(
      controller.createProvider({
        name: 'dbprov',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      controller.createProvider({
        name: 'dbprov',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toThrow('已存在同名网页配置');
    expect(rows).toHaveLength(1);
  });

  it('未设置 FLOWAGENT_SECRET_KEY → 503，且不落库', async () => {
    delete process.env[SECRET_KEY_ENV];
    const { controller, rows } = makeStack();
    await expect(
      controller.createProvider({
        name: 'webprov',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toThrow(
      '未设置 FLOWAGENT_SECRET_KEY，无法在网页端保存密钥；请在服务端环境变量中设置后重启',
    );
    await expect(
      controller.createProvider({
        name: 'webprov',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rows).toHaveLength(0);
  });
});

describe('LlmProviderController PATCH providers/:name（网页端更新）', () => {
  beforeEach(() => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__BASEURL', 'https://api.openai.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__APIKEY', ENV_OPENAI_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__MODELS', 'gpt-4o');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('省略 apiKey 保留原值，更新字段生效，响应不含明文', async () => {
    const { controller, rows } = makeStack([makeRow()]);
    const response = await controller.updateProvider('dbprov', {
      baseURL: 'https://moved.example.com/v2/',
      models: 'd-9',
    });
    expect(response).toEqual({ name: 'dbprov' });
    expect(rows[0]?.baseURL).toBe('https://moved.example.com/v2');
    expect(rows[0]?.models).toBe('d-9');
    expect(rows[0]?.apiKeyEncrypted).not.toContain(DB_KEY);
    expect(decryptSecret(rows[0]?.apiKeyEncrypted ?? '', process.env)).toBe(DB_KEY);
    expect(JSON.stringify(response)).not.toContain(DB_KEY);
  });

  it('携带 apiKey 时重新加密为新密钥', async () => {
    const { controller, rows } = makeStack([makeRow()]);
    await controller.updateProvider('dbprov', { apiKey: 'sk-rotated' });
    expect(decryptSecret(rows[0]?.apiKeyEncrypted ?? '', process.env)).toBe('sk-rotated');
  });

  it('空请求体 → 400；字段非法 → 400', async () => {
    const { controller } = makeStack([makeRow()]);
    await expect(controller.updateProvider('dbprov', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.updateProvider('dbprov', { baseURL: 'not a url' })).rejects.toThrow(
      'baseURL 非法',
    );
    await expect(controller.updateProvider('dbprov', { models: ' , ' })).rejects.toThrow(
      'models 不能为空',
    );
    await expect(controller.updateProvider('dbprov', { apiKey: '  ' })).rejects.toThrow(
      'apiKey 不能为空',
    );
  });

  it('未知名称 → 404「不存在或来自环境变量」；环境变量同名 → 404（env 条目不可经 API 修改）', async () => {
    const { controller } = makeStack([makeRow()]);
    await expect(controller.updateProvider('missing', { models: 'm' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.updateProvider('missing', { models: 'm' })).rejects.toThrow(
      '不存在或来自环境变量',
    );
    await expect(controller.updateProvider('openai', { models: 'm' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('仅在不加密新 apiKey 时才需要加密能力：无 secret 改 baseURL 仍成功，改 apiKey 则 503', async () => {
    delete process.env[SECRET_KEY_ENV];
    const { controller, rows } = makeStack([makeRow()]);
    await expect(
      controller.updateProvider('dbprov', { baseURL: 'https://moved.example.com/v2' }),
    ).resolves.toEqual({ name: 'dbprov' });
    await expect(
      controller.updateProvider('dbprov', { apiKey: 'sk-rotated' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.updateProvider('dbprov', { apiKey: 'sk-rotated' })).rejects.toThrow(
      '未设置 FLOWAGENT_SECRET_KEY',
    );
    // 失败的更新不得改动密文（用主密钥显式解密验证）
    expect(decryptSecret(rows[0]?.apiKeyEncrypted ?? '', { [SECRET_KEY_ENV]: MASTER_KEY })).toBe(
      DB_KEY,
    );
  });
});

describe('LlmProviderController DELETE providers/:name（网页端删除）', () => {
  beforeEach(() => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__BASEURL', 'https://api.openai.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__APIKEY', ENV_OPENAI_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__MODELS', 'gpt-4o');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('删除网页配置 → 204（无返回体），行与快照同步移除', async () => {
    const { controller, service, rows } = makeStack([makeRow()]);
    await expect(controller.deleteProvider('dbprov')).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
    expect(service.getSnapshot().has('dbprov')).toBe(false);
    await expect(controller.updateProvider('dbprov', { models: 'm' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('未知名称 → 404「不存在或来自环境变量」；环境变量同名 → 404（env 条目不可经 API 删除）', async () => {
    const { controller } = makeStack();
    await expect(controller.deleteProvider('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.deleteProvider('missing')).rejects.toThrow('不存在或来自环境变量');
    await expect(controller.deleteProvider('openai')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.deleteProvider('openai')).rejects.toThrow('不存在或来自环境变量');
  });
});

describe('LlmProviderController 并发竞态错误映射（Prisma P2002/P2025 不以 500 暴露）', () => {
  beforeEach(() => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__BASEURL', 'https://api.openai.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__APIKEY', ENV_OPENAI_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__MODELS', 'gpt-4o');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function prismaError(code: 'P2002' | 'P2025'): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError(`mock prisma ${code}`, {
      code,
      clientVersion: 'test',
    });
  }

  it('并发创建重名：预查通过但 create 撞唯一约束（P2002）→ 409「已存在同名网页配置」', async () => {
    const { controller, service, rows } = makeStack();
    vi.spyOn(service, 'create').mockRejectedValue(prismaError('P2002'));
    await expect(
      controller.createProvider({
        name: 'webprov',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      controller.createProvider({
        name: 'webprov',
        baseURL: 'https://w.example.com/v1',
        apiKey: DB_KEY,
        models: 'w-1',
      }),
    ).rejects.toThrow('已存在同名网页配置');
    expect(rows).toHaveLength(0);
  });

  it('并发删除后的 PATCH/DELETE：update/remove 抛 P2025 → 404「不存在或来自环境变量」', async () => {
    const { controller, service } = makeStack([makeRow()]);
    vi.spyOn(service, 'update').mockRejectedValue(prismaError('P2025'));
    await expect(controller.updateProvider('dbprov', { models: 'm' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.updateProvider('dbprov', { models: 'm' })).rejects.toThrow(
      '不存在或来自环境变量',
    );

    vi.spyOn(service, 'remove').mockRejectedValue(prismaError('P2025'));
    await expect(controller.deleteProvider('dbprov')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.deleteProvider('dbprov')).rejects.toThrow('不存在或来自环境变量');
  });
});

describe('合并解析热生效（网页端保存后无需重启）', () => {
  beforeEach(() => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__BASEURL', 'https://api.openai.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__APIKEY', ENV_OPENAI_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__MODELS', 'gpt-4o');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('适配器先于创建构建：创建后 chatCompletion 立即路由到新 Provider（URL/密钥/模型正确）', async () => {
    const { controller, adapter } = makeStack();
    expect(adapter.hasProvider('webprov')).toBe(false);

    await controller.createProvider({
      name: 'webprov',
      baseURL: 'https://web.example.com/v1',
      apiKey: DB_KEY,
      models: 'w-1',
    });
    expect(adapter.hasProvider('webprov')).toBe(true);
    expect(adapter.listProviderNames()).toContain('webprov');

    const fetchMock = vi.fn(async () =>
      fakeResponse(200, '{"choices":[{"message":{"content":"pong"}}]}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await adapter.chatCompletion('webprov', 'w-1', { messages: [{ role: 'user', content: 'hi' }] });

    const calls = fetchMock.mock.calls as unknown as Array<
      [url: unknown, init?: { headers?: Record<string, string>; body?: string }]
    >;
    expect(calls[0]?.[0]).toBe('https://web.example.com/v1/chat/completions');
    expect(calls[0]?.[1]?.headers?.Authorization).toBe(`Bearer ${DB_KEY}`);
    expect(JSON.parse(calls[0]?.[1]?.body ?? '{}')).toMatchObject({ model: 'w-1' });
  });

  it('网页端新建的 Provider 立即可测（POST providers/test 走合并解析）', async () => {
    const { controller } = makeStack();
    await controller.createProvider({
      name: 'webprov',
      baseURL: 'https://web.example.com/v1',
      apiKey: DB_KEY,
      models: 'w-1',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, '{"choices":[{"message":{"content":"pong"}}]}')),
    );
    const outcome: ProviderTestOutcome = await controller.testProvider({
      provider: 'webprov',
      model: 'w-1',
    });
    expect(outcome).toEqual({ ok: true, latencyMs: expect.any(Number) });
  });

  it('删除网页配置后，下一次调用立即回到未配置状态', async () => {
    const { controller, adapter } = makeStack();
    await controller.createProvider({
      name: 'webprov',
      baseURL: 'https://web.example.com/v1',
      apiKey: DB_KEY,
      models: 'w-1',
    });
    expect(adapter.hasProvider('webprov')).toBe(true);
    await controller.deleteProvider('webprov');
    expect(adapter.hasProvider('webprov')).toBe(false);
    await expect(adapter.chatCompletion('webprov', 'w-1', { messages: [] })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
  });
});

describe('LlmProviderController POST providers/test（既有行为回归）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function makeController(): LlmProviderController {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__BASEURL', 'https://api.openai.com/v1');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__APIKEY', 'sk-super-secret');
    vi.stubEnv('FLOWAGENT_PROVIDERS_OPENAI__MODELS', 'gpt-4o');
    const { controller } = makeStack();
    return controller;
  }

  it('上游正常 → 200 { ok: true, latencyMs }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, '{"choices":[{"message":{"content":"pong"}}]}')),
    );
    const outcome = await makeController().testProvider({ provider: 'openai', model: 'gpt-4o' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.latencyMs).toBeTypeOf('number');
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('请求体缺失/非法 → 400 中文错误', async () => {
    const controller = makeController();
    await expect(controller.testProvider({ provider: 'openai' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.testProvider({ model: 'gpt-4o' })).rejects.toThrow(
      'provider 与 model 必须为非空字符串',
    );
    await expect(controller.testProvider('not-an-object')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.testProvider(null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('provider 未配置 → 404 中文错误', async () => {
    await expect(
      makeController().testProvider({ provider: 'nope', model: 'm' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeController().testProvider({ provider: 'nope', model: 'm' })).rejects.toThrow(
      'Provider “nope” 未配置或不存在',
    );
  });

  it('上游 404 → 200 { ok: false, message }（中文），不含上游原文与 apiKey', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(
          404,
          'Thank you for participating in the Stealth Ox Alpha testing period. user_id=9527 billing=https://pay.stealth-ox.example/9527',
        ),
      ),
    );
    const outcome: ProviderTestOutcome = await makeController().testProvider({
      provider: 'openai',
      model: 'ghost-model',
    });
    expect(outcome).toEqual({ ok: false, message: '模型不存在或已下线（上游 404）' });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('Stealth Ox');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('sk-super-secret');
  });

  it('上游 401 → 200 { ok: false, message: 密钥无效或额度不足 }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(401, '{"error":"Insufficient balance"}')),
    );
    const outcome = await makeController().testProvider({ provider: 'openai', model: 'gpt-4o' });
    expect(outcome).toEqual({ ok: false, message: '密钥无效或额度不足（上游 401）' });
  });

  it('上游 429 / 5xx → 200 { ok: false, message }，绝不变 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(429, 'rate limited')),
    );
    await expect(
      makeController().testProvider({ provider: 'openai', model: 'gpt-4o' }),
    ).resolves.toEqual({ ok: false, message: '上游限流，请稍后重试（上游 429）' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(500, 'internal error')),
    );
    await expect(
      makeController().testProvider({ provider: 'openai', model: 'gpt-4o' }),
    ).resolves.toEqual({ ok: false, message: '上游服务错误（上游 500）' });
  });

  it('测试链路意外异常被兜底为 ok:false（不冒泡成 500）', async () => {
    const controller = makeController();
    const internal = controller as unknown as { llmAdapter: LlmAdapter };
    vi.spyOn(internal.llmAdapter, 'testProvider').mockRejectedValue(new Error('boom'));
    const outcome = await controller.testProvider({ provider: 'openai', model: 'gpt-4o' });
    expect(outcome).toEqual({ ok: false, message: '测试请求失败，请稍后重试' });
  });
});
