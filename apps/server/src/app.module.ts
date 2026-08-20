import { Module } from '@nestjs/common';

import { EngineModule } from './engine/engine.module';
import { EventStoreModule } from './engine/event-store.module';
import { LlmModule } from './llm/llm.module';
import { McpModule } from './mcp/mcp.module';
import { PrismaModule } from './prisma/prisma.module';
import { RunsModule } from './runs/runs.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [
    PrismaModule,
    EventStoreModule,
    WorkflowModule,
    McpModule,
    LlmModule,
    RunsModule,
    EngineModule,
  ],
})
export class AppModule {}
