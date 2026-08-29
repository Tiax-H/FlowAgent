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
    // 控制面意图（暂停/取消已请求未生效）暴露给 run summary/详情 DTO
    this.runsService.setControlIntentProvider((runId) => this.engine.getControlIntent(runId));
  }
}
