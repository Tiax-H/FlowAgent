import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { RunsService } from './runs.service';

@Controller()
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Post('workflows/:workflowId/runs')
  async startRun(
    @Param('workflowId') workflowId: string,
    @Body() body: { input?: unknown } = {},
  ): Promise<{ runId: string }> {
    const runId = await this.runsService.startRun(workflowId, body.input ?? null);
    return { runId };
  }

  @Get('runs')
  async listRuns(): Promise<unknown[]> {
    return this.runsService.listRuns();
  }

  @Get('runs/:id')
  async getRun(@Param('id') id: string): Promise<unknown> {
    return this.runsService.getRun(id);
  }

  @Get('runs/:id/events')
  async getEvents(@Param('id') id: string): Promise<unknown[]> {
    return this.runsService.getEvents(id);
  }
}
