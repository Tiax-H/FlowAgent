import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { RunsService, parseRunsListLimit } from './runs.service';

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

  /**
   * 运行列表：?limit= 控制返回条数（默认 100，上限 500，非法值回退默认），
   * 按 createdAt 倒序取前 N。所属工作流已删除的 run 携带 workflowDeleted: true。
   */
  @Get('runs')
  async listRuns(@Query('limit') limit?: string): Promise<unknown[]> {
    return this.runsService.listRuns(undefined, parseRunsListLimit(limit));
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
