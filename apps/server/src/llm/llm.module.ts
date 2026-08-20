import { Global, Module } from '@nestjs/common';

import { LlmAdapter } from './llm.adapter';

@Global()
@Module({
  providers: [
    {
      provide: LlmAdapter,
      useFactory: () => LlmAdapter.fromEnv(),
    },
  ],
  exports: [LlmAdapter],
})
export class LlmModule {}
