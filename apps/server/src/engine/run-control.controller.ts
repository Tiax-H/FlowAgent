import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import type { HumanInputRequest } from '@flowagent/shared';

import { EngineService } from './scheduler';

/**
 * 运行控制面：三条恢复路径（Human 审批 / 主动暂停恢复 / 失败断点重试）+ 取消。
 * 全部动作在引擎侧统一为「追加事件 → 重入 execute」，事件表保持 append-only。
 */
@Controller()
export class RunControlController {
  constructor(private readonly engine: EngineService) {}

  @Post('runs/:id/pause')
  async pause(@Param('id') id: string): Promise<{ ok: true }> {
    await this.engine.pause(id);
    return { ok: true };
  }

  @Post('runs/:id/resume')
  async resume(@Param('id') id: string): Promise<{ ok: true }> {
    await this.engine.resume(id);
    return { ok: true };
  }

  @Post('runs/:id/retry')
  async retry(@Param('id') id: string): Promise<{ ok: true }> {
    await this.engine.retryFailed(id);
    return { ok: true };
  }

  @Post('runs/:id/cancel')
  async cancel(@Param('id') id: string): Promise<{ ok: true }> {
    await this.engine.cancel(id);
    return { ok: true };
  }

  @Post('runs/:id/human-input')
  async humanInput(@Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    await this.engine.submitHumanInput(id, parseHumanInputRequest(body));
    return { ok: true };
  }
}

function parseHumanInputRequest(body: unknown): HumanInputRequest {
  if (body === null || typeof body !== 'object') {
    throw new BadRequestException('请求体必须为 JSON 对象');
  }
  const approved = (body as { approved?: unknown }).approved;
  if (typeof approved !== 'boolean') {
    throw new BadRequestException('approved 必须为 boolean');
  }
  return body as HumanInputRequest;
}
