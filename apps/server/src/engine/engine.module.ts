import { Module, type OnModuleInit } from '@nestjs/common';

import { McpModule } from '../mcp/mcp.module';
import { RunsModule } from '../runs/runs.module';
import { RunsService } from '../runs/runs.service';
import { EngineService } from './scheduler';

@Module({
  imports: [RunsModule, McpModule],
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
