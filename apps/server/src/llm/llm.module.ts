import { Global, Module } from '@nestjs/common';

import { LlmAdapter } from './llm.adapter';
import { LlmProviderController } from './llm-provider.controller';

@Global()
@Module({
  controllers: [LlmProviderController],
  providers: [
    {
      provide: LlmAdapter,
      useFactory: () => LlmAdapter.fromEnv(),
    },
  ],
  exports: [LlmAdapter],
})
export class LlmModule {}
