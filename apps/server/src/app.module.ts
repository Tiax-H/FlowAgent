import { Module } from '@nestjs/common';

import { McpModule } from './mcp/mcp.module';
import { PrismaModule } from './prisma/prisma.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [PrismaModule, WorkflowModule, McpModule],
})
export class AppModule {}
