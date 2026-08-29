import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { ProviderTestOutcome } from './llm.adapter';
import { LlmAdapter, parseProviderConfigs } from './llm.adapter';
import {
  normalizeBaseUrlInput,
  parseModelsCsv,
  PROVIDER_NAME_PATTERN,
  ProviderConfigService,
} from './provider-config.service';
import { isEncryptionEnabled } from './provider-crypto';

/** POST /api/llm/providers/test 请求体 */
export interface TestProviderDto {
  provider: string;
  model: string;
}

/** POST /api/llm/providers 请求体（models 为逗号分隔字符串） */
export interface CreateProviderDto {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string;
}

/** PATCH /api/llm/providers/:name 请求体（apiKey 省略表示保留原值） */
export interface UpdateProviderDto {
  baseURL?: string;
  apiKey?: string;
  models?: string;
}

/** GET /api/llm/providers 单个条目：source 标记来源；db 条目额外返回 baseURL（非机密）/apiKeyLast4/updatedAt */
export interface ProviderListItem {
  name: string;
  models: string[];
  source: 'env' | 'db';
  /** 仅 db 条目返回（baseURL 非机密，供网页端编辑弹窗预填）；env 条目不返回 */
  baseURL?: string;
  apiKeyLast4?: string;
  updatedAt?: string;
}

/** GET /api/llm/providers 响应：configurable 表示加密能力已启用（可网页端保存密钥） */
export interface ProviderListResponse {
  configurable: boolean;
  providers: ProviderListItem[];
}

/** FLOWAGENT_SECRET_KEY 未启用时的统一 503 文案（写入路径） */
const ENCRYPTION_DISABLED_MESSAGE =
  '未设置 FLOWAGENT_SECRET_KEY，无法在网页端保存密钥；请在服务端环境变量中设置后重启';

@Controller('llm')
export class LlmProviderController {
  constructor(
    private readonly llmAdapter: LlmAdapter,
    private readonly providerConfigService: ProviderConfigService,
  ) {}

  /**
   * GET /api/llm/providers：env 与数据库合并后的 Provider 列表（按名称排序）。
   * 绝不返回 apiKey；db 条目返回 baseURL（非机密）与掩码尾 4 位（apiKeyLast4），env 条目不返回 baseURL。
   */
  @Get('providers')
  async listProviders(): Promise<ProviderListResponse> {
    const envProviders = parseProviderConfigs();
    const dbEntries = await this.providerConfigService.listDbEntries();
    const items: ProviderListItem[] = [
      ...[...envProviders.values()].map((provider) => ({
        name: provider.name,
        models: [...provider.models],
        source: 'env' as const,
      })),
      ...dbEntries.map((entry) => ({
        name: entry.name,
        models: entry.models,
        source: 'db' as const,
        baseURL: entry.baseURL,
        apiKeyLast4: entry.apiKeyLast4,
        updatedAt: entry.updatedAt,
      })),
    ];
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { configurable: isEncryptionEnabled(), providers: items };
  }

  /**
   * POST /api/llm/providers：创建网页端 Provider（密钥 AES-256-GCM 加密落库，保存后热生效）。
   * 400 入参非法（中文提示）；409 与环境变量或已有网页配置同名（并发创建撞唯一约束同样映射 409）；
   * 503 加密能力未启用。
   */
  @Post('providers')
  async createProvider(@Body() body: unknown): Promise<{ name: string }> {
    const input = parseCreateProviderBody(body);
    if (!isEncryptionEnabled()) {
      throw new ServiceUnavailableException(ENCRYPTION_DISABLED_MESSAGE);
    }
    if (parseProviderConfigs().has(input.name)) {
      throw new ConflictException('与环境变量配置同名，请直接修改环境变量');
    }
    if (await this.providerConfigService.findRow(input.name)) {
      throw new ConflictException('已存在同名网页配置');
    }
    try {
      await this.providerConfigService.create(input);
    } catch (error) {
      // 并发创建重名：预查通过后仍可能撞 name 唯一约束（P2002），以 409 而非 500 暴露
      if (isPrismaKnownError(error, 'P2002')) {
        throw new ConflictException('已存在同名网页配置');
      }
      throw error;
    }
    return { name: input.name };
  }

  /**
   * PATCH /api/llm/providers/:name：更新网页端 Provider（省略字段保留原值）。
   * 404 不存在或来自环境变量（env 条目不可经 API 修改；并发删除后的更新同样映射 404）；
   * 400 字段非法；503 仅在需要加密新 apiKey 而加密能力未启用时。
   */
  @Patch('providers/:name')
  async updateProvider(
    @Param('name') name: string,
    @Body() body: unknown,
  ): Promise<{ name: string }> {
    const row = await this.providerConfigService.findRow(name);
    if (!row || parseProviderConfigs().has(name)) {
      throw new NotFoundException('不存在或来自环境变量');
    }
    const input = parseUpdateProviderBody(body);
    if (input.apiKey !== undefined && !isEncryptionEnabled()) {
      throw new ServiceUnavailableException(ENCRYPTION_DISABLED_MESSAGE);
    }
    try {
      await this.providerConfigService.update(name, input);
    } catch (error) {
      // 并发删除后更新：预查通过后行已被删（P2025），以 404 而非 500 暴露
      if (isPrismaKnownError(error, 'P2025')) {
        throw new NotFoundException('不存在或来自环境变量');
      }
      throw error;
    }
    return { name };
  }

  /**
   * DELETE /api/llm/providers/:name：删除网页端 Provider（env 条目不可经 API 删除）。
   * 404 不存在或来自环境变量（并发删除后的重复删除同样映射 404）。
   */
  @Delete('providers/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteProvider(@Param('name') name: string): Promise<void> {
    if (parseProviderConfigs().has(name)) {
      throw new NotFoundException('不存在或来自环境变量');
    }
    const row = await this.providerConfigService.findRow(name);
    if (!row) {
      throw new NotFoundException('不存在或来自环境变量');
    }
    try {
      await this.providerConfigService.remove(name);
    } catch (error) {
      // 并发删除：预查通过后行已被另一请求删除（P2025），以 404 而非 500 暴露
      if (isPrismaKnownError(error, 'P2025')) {
        throw new NotFoundException('不存在或来自环境变量');
      }
      throw error;
    }
  }

  /**
   * POST /api/llm/providers/test：Provider 连通性测试（发一条 max_tokens=1 的最小补全）。
   * 走 env + 数据库合并解析，网页端新建的 Provider 无需重启即可测试；
   * 上游失败一律返回 200 + { ok: false, message }（中文提示），绝不变 500；
   * 响应与日志不含 apiKey，也不透出上游响应原文。
   */
  @Post('providers/test')
  @HttpCode(HttpStatus.OK)
  async testProvider(@Body() body: unknown): Promise<ProviderTestOutcome> {
    const { provider, model } = parseTestProviderBody(body);
    if (!this.llmAdapter.hasProvider(provider)) {
      throw new NotFoundException(`Provider “${provider}” 未配置或不存在`);
    }
    try {
      return await this.llmAdapter.testProvider(provider, model);
    } catch (error) {
      // 兜底防线：测试链路的任何意外异常都不得以 500 暴露给设置页
      if (error instanceof HttpException) throw error;
      return { ok: false, message: '测试请求失败，请稍后重试' };
    }
  }
}

/** 请求体手工校验（模块未启用全局 ValidationPipe，与 McpService 的校验风格一致） */
function parseTestProviderBody(body: unknown): TestProviderDto {
  if (!isPlainObject(body)) {
    throw new BadRequestException('请求体必须是 JSON 对象');
  }
  const { provider, model } = body;
  if (
    typeof provider !== 'string' ||
    provider.trim().length === 0 ||
    typeof model !== 'string' ||
    model.trim().length === 0
  ) {
    throw new BadRequestException('provider 与 model 必须为非空字符串');
  }
  return { provider, model };
}

/** POST 创建请求体校验：返回归一化后的服务层入参（密钥 trim） */
function parseCreateProviderBody(body: unknown): {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string;
} {
  if (!isPlainObject(body)) {
    throw new BadRequestException('请求体必须是 JSON 对象');
  }
  const { name, baseURL, apiKey, models } = body;
  if (typeof name !== 'string' || !PROVIDER_NAME_PATTERN.test(name)) {
    throw new BadRequestException(
      '名称不符合规则（仅限小写字母/数字/中划线，1-32 位，且以字母或数字开头）',
    );
  }
  if (typeof baseURL !== 'string') {
    throw new BadRequestException('baseURL 非法（必须是可解析的 http/https URL）');
  }
  const normalizedBaseUrl = normalizeBaseUrlInput(baseURL);
  if (!normalizedBaseUrl) {
    throw new BadRequestException('baseURL 非法（必须是可解析的 http/https URL）');
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new BadRequestException('apiKey 不能为空');
  }
  if (typeof models !== 'string' || parseModelsCsv(models).length === 0) {
    throw new BadRequestException('models 不能为空（至少填写一个模型名，逗号分隔）');
  }
  return {
    name,
    baseURL: normalizedBaseUrl,
    apiKey: apiKey.trim(),
    models: parseModelsCsv(models).join(','),
  };
}

/** PATCH 更新请求体校验：至少提供一个字段，提供的字段逐个校验（省略字段保留原值） */
function parseUpdateProviderBody(body: unknown): {
  baseURL?: string;
  apiKey?: string;
  models?: string;
} {
  if (!isPlainObject(body)) {
    throw new BadRequestException('请求体必须是 JSON 对象');
  }
  const { baseURL, apiKey, models } = body;
  if (baseURL === undefined && apiKey === undefined && models === undefined) {
    throw new BadRequestException('至少需要提供 baseURL、apiKey 或 models 之一');
  }
  const input: { baseURL?: string; apiKey?: string; models?: string } = {};
  if (baseURL !== undefined) {
    if (typeof baseURL !== 'string') {
      throw new BadRequestException('baseURL 非法（必须是可解析的 http/https URL）');
    }
    const normalizedBaseUrl = normalizeBaseUrlInput(baseURL);
    if (!normalizedBaseUrl) {
      throw new BadRequestException('baseURL 非法（必须是可解析的 http/https URL）');
    }
    input.baseURL = normalizedBaseUrl;
  }
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new BadRequestException('apiKey 不能为空');
    }
    input.apiKey = apiKey.trim();
  }
  if (models !== undefined) {
    if (typeof models !== 'string' || parseModelsCsv(models).length === 0) {
      throw new BadRequestException('models 不能为空（至少填写一个模型名，逗号分隔）');
    }
    input.models = parseModelsCsv(models).join(',');
  }
  return input;
}

/**
 * 判断异常是否为指定 code 的 Prisma 已知请求错误（并发场景的 P2002 唯一约束 / P2025 记录不存在等）。
 */
function isPrismaKnownError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
