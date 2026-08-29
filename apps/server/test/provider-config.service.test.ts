import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import {
  normalizeBaseUrlInput,
  parseModelsCsv,
  PROVIDER_NAME_PATTERN,
  ProviderConfigService,
  type ProviderConfigRow,
} from '../src/llm/provider-config.service';
import { decryptSecret, encryptSecret, SECRET_KEY_ENV } from '../src/llm/provider-crypto';

const MASTER_KEY = 'unit-test-master-key-0123456789abcdef';
const OTHER_KEY = 'another-unit-test-key-9876543210';

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
    apiKeyEncrypted: encryptSecret('sk-db-plain', { [SECRET_KEY_ENV]: MASTER_KEY }),
    models: 'd-1, d-2',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function makeService(rows: ProviderConfigRow[] = []): Promise<ProviderConfigService> {
  return new ProviderConfigService(makePrismaStub(rows) as unknown as PrismaService);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ProviderConfigService 快照与解密', () => {
  it('reload 后快照包含解密后的配置（明文密钥仅存在于内存）', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const service = await makeService([makeRow()]);
    await service.reload();
    const snapshot = service.getSnapshot();
    const config = snapshot.get('dbprov');
    expect(config).toEqual({
      name: 'dbprov',
      baseURL: 'https://db.example.com/v1',
      apiKey: 'sk-db-plain',
      models: ['d-1', 'd-2'],
    });
  });

  it('密文解密失败的行被跳过（主密钥变更场景），其余行不受影响', async () => {
    vi.stubEnv(SECRET_KEY_ENV, OTHER_KEY);
    const service = await makeService([
      makeRow({ name: 'stale', apiKeyEncrypted: 'v1:corrupted:corrupted:corrupted' }),
      makeRow({
        name: 'fresh',
        apiKeyEncrypted: encryptSecret('sk-fresh', { [SECRET_KEY_ENV]: OTHER_KEY }),
      }),
    ]);
    await service.reload();
    expect(service.getSnapshot().has('stale')).toBe(false);
    expect(service.getSnapshot().get('fresh')?.apiKey).toBe('sk-fresh');
  });

  it('create 落库为密文（v1: 前缀、不含明文）并立即进入快照', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const rows: ProviderConfigRow[] = [];
    const service = await makeService(rows);
    await service.create({
      name: 'webprov',
      baseURL: 'https://web.example.com/v1',
      apiKey: 'sk-web-plain',
      models: 'w-1,w-2',
    });
    expect(rows).toHaveLength(1);
    const stored = rows[0];
    expect(stored?.apiKeyEncrypted).not.toBe('sk-web-plain');
    expect(stored?.apiKeyEncrypted.startsWith('v1:')).toBe(true);
    expect(decryptSecret(stored?.apiKeyEncrypted ?? '', process.env)).toBe('sk-web-plain');
    expect(stored?.baseURL).toBe('https://web.example.com/v1');
    expect(stored?.models).toBe('w-1,w-2');
    expect(service.getSnapshot().get('webprov')?.apiKey).toBe('sk-web-plain');
  });

  it('update 省略 apiKey 时保留原密文（原密钥继续生效），更新字段生效', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const original = makeRow();
    const rows = [original];
    const service = await makeService(rows);
    await service.reload();
    await service.update('dbprov', { baseURL: 'https://moved.example.com/v2', models: 'd-9' });
    expect(rows[0]?.apiKeyEncrypted).toBe(original.apiKeyEncrypted);
    expect(rows[0]?.baseURL).toBe('https://moved.example.com/v2');
    expect(rows[0]?.models).toBe('d-9');
    const snapshot = service.getSnapshot().get('dbprov');
    expect(snapshot?.apiKey).toBe('sk-db-plain');
    expect(snapshot?.baseURL).toBe('https://moved.example.com/v2');
    expect(snapshot?.models).toEqual(['d-9']);
  });

  it('update 携带 apiKey 时重新加密为新密钥', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const rows = [makeRow()];
    const service = await makeService(rows);
    await service.reload();
    await service.update('dbprov', { apiKey: 'sk-rotated' });
    expect(rows[0]?.apiKeyEncrypted).not.toBe(makeRow().apiKeyEncrypted);
    expect(service.getSnapshot().get('dbprov')?.apiKey).toBe('sk-rotated');
  });

  it('remove 删除行并移出快照', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const rows = [makeRow()];
    const service = await makeService(rows);
    await service.reload();
    await service.remove('dbprov');
    expect(rows).toHaveLength(0);
    expect(service.getSnapshot().has('dbprov')).toBe(false);
  });

  it('findRow 按名称精确查询', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const service = await makeService([makeRow()]);
    expect((await service.findRow('dbprov'))?.name).toBe('dbprov');
    expect(await service.findRow('missing')).toBeNull();
  });

  it('listDbEntries 返回 baseURL、掩码尾 4 位与 ISO 时间，绝不含明文密钥', async () => {
    vi.stubEnv(SECRET_KEY_ENV, MASTER_KEY);
    const service = await makeService([makeRow({ models: 'd-1' })]);
    const entries = await service.listDbEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: 'dbprov',
      baseURL: 'https://db.example.com/v1',
      models: ['d-1'],
      apiKeyLast4: 'lain',
      updatedAt: expect.any(String),
    });
    expect(new Date(entries[0]?.updatedAt ?? '').toISOString()).toBe(entries[0]?.updatedAt);
    expect(JSON.stringify(entries)).not.toContain('sk-db-plain');
  });
});

describe('Provider 名称与输入归一化规则', () => {
  it('PROVIDER_NAME_PATTERN：全小写字母/数字/中划线，1-32 位，以字母或数字开头', () => {
    expect(PROVIDER_NAME_PATTERN.test('openai')).toBe(true);
    expect(PROVIDER_NAME_PATTERN.test('gpt-4o-mini')).toBe(true);
    expect(PROVIDER_NAME_PATTERN.test('a')).toBe(true);
    expect(PROVIDER_NAME_PATTERN.test('9lives')).toBe(true);
    expect(PROVIDER_NAME_PATTERN.test('OpenAI')).toBe(false);
    expect(PROVIDER_NAME_PATTERN.test('-abc')).toBe(false);
    expect(PROVIDER_NAME_PATTERN.test('a_b')).toBe(false);
    expect(PROVIDER_NAME_PATTERN.test('')).toBe(false);
    expect(PROVIDER_NAME_PATTERN.test('a'.repeat(32))).toBe(true);
    expect(PROVIDER_NAME_PATTERN.test('a'.repeat(33))).toBe(false);
  });

  it('parseModelsCsv：逗号分隔、trim 去空', () => {
    expect(parseModelsCsv('a, b,,c ,')).toEqual(['a', 'b', 'c']);
    expect(parseModelsCsv('')).toEqual([]);
    expect(parseModelsCsv('  ')).toEqual([]);
  });

  it('normalizeBaseUrlInput：http/https 可解析并去末尾斜杠，其余返回 null', () => {
    expect(normalizeBaseUrlInput('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrlInput('  http://api.example.com  ')).toBe('http://api.example.com');
    expect(normalizeBaseUrlInput('https://api.example.com')).toBe('https://api.example.com');
    expect(normalizeBaseUrlInput('ftp://api.example.com')).toBeNull();
    expect(normalizeBaseUrlInput('not a url')).toBeNull();
    expect(normalizeBaseUrlInput('')).toBeNull();
  });
});
