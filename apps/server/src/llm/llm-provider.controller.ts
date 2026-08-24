import { Controller, Get } from '@nestjs/common';

import type { LlmProviderInfo } from './llm.adapter';
import { LlmAdapter } from './llm.adapter';

@Controller('llm')
export class LlmProviderController {
  constructor(private readonly llmAdapter: LlmAdapter) {}

  /** GET /api/llm/providers：已配置 Provider 列表（只含 name/models，绝不返回 apiKey/baseURL） */
  @Get('providers')
  listProviders(): { providers: LlmProviderInfo[] } {
    return { providers: this.llmAdapter.listProviders() };
  }
}
