import { Module } from '@nestjs/common';

import { LlmModule } from './llm/llm.module';
import { McpModule } from './mcp/mcp.module';
import { PrismaModule } from './prisma/prisma.module';
import { RunsModule } from './runs/runs.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [PrismaModule, WorkflowModule, McpModule, LlmModule, RunsModule],
})
export class AppModule {}
