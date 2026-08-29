import { Global, Module } from '@nestjs/common';

import { mergeProviderConfigs, LlmAdapter, parseProviderConfigs } from './llm.adapter';
import { LlmProviderController } from './llm-provider.controller';
import { ProviderConfigService } from './provider-config.service';

@Global()
@Module({
  controllers: [LlmProviderController],
  providers: [
    ProviderConfigService,
    {
      provide: LlmAdapter,
      inject: [ProviderConfigService],
      // 合并解析器：env 常量 Map + 数据库快照（网页端保存后快照即时刷新，下一次调用即生效）
      useFactory: (providerConfigService: ProviderConfigService) =>
        new LlmAdapter(() =>
          mergeProviderConfigs(parseProviderConfigs(), providerConfigService.getSnapshot()),
        ),
    },
  ],
  exports: [LlmAdapter, ProviderConfigService],
})
export class LlmModule {}
