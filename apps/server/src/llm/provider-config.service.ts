/**
 * Provider 配置表（网页端增删改查）服务：Prisma 读写 + AES-256-GCM 密钥加解密 + 内存快照。
 *
 * 快照（getSnapshot）供 LlmAdapter 的合并 resolver 读取：每次写入后同步刷新，
 * 网页端保存后下一次调用即生效，无需重启。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { decryptSecret, encryptSecret } from './provider-crypto';
import { normalizeBaseUrl, type LlmProviderConfig } from './llm.adapter';
import { PrismaService } from '../prisma/prisma.service';

/** Prisma provider_configs 行的结构投影（与生成类型一致，便于测试桩构造） */
export interface ProviderConfigRow {
  name: string;
  baseURL: string;
  apiKeyEncrypted: string;
  models: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 数据库路径 Provider 的公开信息（含 baseURL 与掩码尾 4 位，绝不含明文密钥） */
export interface ProviderDbEntryInfo {
  name: string;
  baseURL: string;
  models: string[];
  apiKeyLast4: string;
  updatedAt: string;
}

/** Provider 名称规则：全小写字母/数字，可含中划线，1-32 位，以字母或数字开头 */
export const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 逗号分隔 models 字符串解析（trim 去空），与 env 解析语义一致 */
export function parseModelsCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

/**
 * 校验并归一网页端输入的 baseURL：http/https 可解析，去末尾斜杠。
 * 非法返回 null（由调用方转为 400）。
 */
export function normalizeBaseUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return normalizeBaseUrl(trimmed);
}

/** 网页端创建入参（已由控制器校验归一） */
export interface CreateProviderInput {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string;
}

/** 网页端更新入参（省略字段表示保留原值，已由控制器校验归一） */
export interface UpdateProviderInput {
  baseURL?: string;
  apiKey?: string;
  models?: string;
}

@Injectable()
export class ProviderConfigService implements OnModuleInit {
  private readonly logger = new Logger(ProviderConfigService.name);
  /** 当前生效的数据库 Provider 快照（已解密，供合并 resolver 同步读取） */
  private snapshot = new Map<string, LlmProviderConfig>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** 从数据库重新加载并解密全部 Provider 行，整体替换内存快照 */
  async reload(): Promise<void> {
    const rows = await this.prisma.providerConfig.findMany();
    const next = new Map<string, LlmProviderConfig>();
    for (const row of rows) {
      try {
        next.set(row.name, {
          name: row.name,
          baseURL: row.baseURL,
          apiKey: decryptSecret(row.apiKeyEncrypted),
          models: parseModelsCsv(row.models),
        });
      } catch {
        // 主密钥变更/密文损坏的行跳过而非让整个 Provider 解析失败；不记录密文内容
        this.logger.warn(
          `数据库 Provider “${row.name}” 的密钥解密失败，已跳过（请检查 FLOWAGENT_SECRET_KEY 是否变更）`,
        );
      }
    }
    this.snapshot = next;
  }

  /** 当前生效的数据库 Provider 快照（合并 resolver 每次调用读取，写入后即生效） */
  getSnapshot(): Map<string, LlmProviderConfig> {
    return this.snapshot;
  }

  /** 按名称查询数据库行（不存在返回 null） */
  async findRow(name: string): Promise<ProviderConfigRow | null> {
    return this.prisma.providerConfig.findUnique({ where: { name } });
  }

  /** 数据库 Provider 公开信息列表（含 baseURL 与掩码尾 4 位；解密失败的行跳过） */
  async listDbEntries(): Promise<ProviderDbEntryInfo[]> {
    const rows = await this.prisma.providerConfig.findMany();
    const entries: ProviderDbEntryInfo[] = [];
    for (const row of rows) {
      try {
        const apiKey = decryptSecret(row.apiKeyEncrypted);
        entries.push({
          name: row.name,
          baseURL: row.baseURL,
          models: parseModelsCsv(row.models),
          apiKeyLast4: apiKey.slice(-4),
          updatedAt: row.updatedAt.toISOString(),
        });
      } catch {
        this.logger.warn(`数据库 Provider “${row.name}” 的密钥解密失败，列表中已跳过`);
      }
    }
    return entries;
  }

  /** 创建数据库 Provider 并刷新快照（明文密钥仅存在于内存，落库前已加密） */
  async create(input: CreateProviderInput): Promise<ProviderConfigRow> {
    const row = await this.prisma.providerConfig.create({
      data: {
        name: input.name,
        baseURL: input.baseURL,
        apiKeyEncrypted: encryptSecret(input.apiKey),
        models: input.models,
      },
    });
    await this.reload();
    return row;
  }

  /** 更新数据库 Provider（省略字段保留原值）并刷新快照 */
  async update(name: string, input: UpdateProviderInput): Promise<ProviderConfigRow> {
    const data: { baseURL?: string; apiKeyEncrypted?: string; models?: string } = {};
    if (input.baseURL !== undefined) data.baseURL = input.baseURL;
    if (input.apiKey !== undefined) data.apiKeyEncrypted = encryptSecret(input.apiKey);
    if (input.models !== undefined) data.models = input.models;
    const row = await this.prisma.providerConfig.update({
      where: { name },
      data,
    });
    await this.reload();
    return row;
  }

  /** 删除数据库 Provider 并刷新快照 */
  async remove(name: string): Promise<void> {
    await this.prisma.providerConfig.delete({ where: { name } });
    await this.reload();
  }
}
