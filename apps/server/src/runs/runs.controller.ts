import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';

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

  /**
   * 删除运行记录（软删）：204。
   * 事件表 append-only（禁止 UPDATE/DELETE），仅给投影缓存行打 hiddenAt 标记；
   * 已删 run 的列表/详情/事件/SSE 一律按 404 处理。
   */
  @Delete('runs/:id')
  @HttpCode(204)
  async deleteRun(@Param('id') id: string): Promise<void> {
    await this.runsService.deleteRun(id);
  }

  /** 轻量状态端点（bridge 轮询用）：只读缓存列，零事件回放 */
  @Get('runs/:id/status')
  async getRunStatus(@Param('id') id: string): Promise<{ id: string; status: string }> {
    return this.runsService.getRunStatus(id);
  }

  @Get('runs/:id/events')
  async getEvents(@Param('id') id: string): Promise<unknown[]> {
    return this.runsService.getEvents(id);
  }
}
