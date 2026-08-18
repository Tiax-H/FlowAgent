import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [PrismaModule, WorkflowModule],
})
export class AppModule {}
