import { Module, type OnModuleInit } from '@nestjs/common';

import { LlmAdapter } from '../llm/llm.adapter';
import { McpRegistryService } from '../mcp/mcp.registry';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from '../runs/runs.service';
import { EventStore } from './event-store.service';
import { EngineService } from './scheduler';

@Module({
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule implements OnModuleInit {
  constructor(
    private readonly engine: EngineService,
    private readonly runsService: RunsService,
  ) {}

  onModuleInit(): void {
    this.runsService.setRunStarter((runId, workflowId, input) =>
      this.engine.execute(runId, workflowId, input),
    );
  }
}

/** 依赖注入编译期校验（防止参数顺序漂移） */
export type EngineDependencies = [PrismaService, EventStore, LlmAdapter, McpRegistryService, RunsService];
