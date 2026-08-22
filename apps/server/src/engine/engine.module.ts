import { Module, type OnModuleInit } from '@nestjs/common';

import { McpModule } from '../mcp/mcp.module';
import { RunsModule } from '../runs/runs.module';
import { RunsService } from '../runs/runs.service';
import { EngineService } from './scheduler';
import { RunControlController } from './run-control.controller';

@Module({
  imports: [RunsModule, McpModule],
  controllers: [RunControlController],
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule implements OnModuleInit {
  constructor(
    private readonly engine: EngineService,
    private readonly runsService: RunsService,
  ) {}

  onModuleInit(): void {
    this.runsService.setRunStarter((runId) => this.engine.execute(runId));
  }
}
