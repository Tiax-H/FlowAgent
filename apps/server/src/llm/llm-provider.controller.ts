import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';

import type { LlmProviderInfo, ProviderTestOutcome } from './llm.adapter';
import { LlmAdapter } from './llm.adapter';

/** POST /api/llm/providers/test 请求体 */
export interface TestProviderDto {
  provider: string;
  model: string;
}

@Controller('llm')
export class LlmProviderController {
  constructor(private readonly llmAdapter: LlmAdapter) {}

  /** GET /api/llm/providers：已配置 Provider 列表（只含 name/models，绝不返回 apiKey/baseURL） */
  @Get('providers')
  listProviders(): { providers: LlmProviderInfo[] } {
    return { providers: this.llmAdapter.listProviders() };
  }

  /**
   * POST /api/llm/providers/test：Provider 连通性测试（发一条 max_tokens=1 的最小补全）。
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
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('请求体必须是 JSON 对象');
  }
  const { provider, model } = body as Record<string, unknown>;
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
