/**
 * 控制面意图暴露回归（UX 问题 3）：
 * 运行中请求暂停/取消后，「已请求但尚未生效」的意图要出现在 run summary/详情 DTO 上，
 * 供前端轮询展示「暂停已请求，将在当前节点结束后生效」；意图生效（终态事件落库）后消失。
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '@flowagent/shared';

import { EngineService } from '../src/engine/scheduler';
import { EventStore } from '../src/engine/event-store.service';
import { LlmAdapter } from '../src/llm/llm.adapter';
import { McpRegistryService } from '../src/mcp/mcp.registry';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunsService } from '../src/runs/runs.service';
import { MemoryEventStore, linearDefinition, node } from './engine-harness';

interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  input: string | null;
  definitionSnapshot: string | null;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  hiddenAt: Date | null;
}

/** 内存 workflow_runs 模型：覆盖 RunsService/EngineService 用到的最小操作面 */
class InMemoryRunModel {
  private readonly rows = new Map<string, RunRecord>();

  create({ data }: { data: Partial<RunRecord> }): RunRecord {
    const row: RunRecord = {
      id: data.id ?? 'run_1',
      workflowId: data.workflowId ?? 'wf_1',
      workflowVersion: data.workflowVersion ?? 1,
      input: data.input ?? null,
      definitionSnapshot: data.definitionSnapshot ?? null,
      status: data.status ?? 'pending',
      output: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(),
      hiddenAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  findUnique({ where }: { where: { id: string } }): RunRecord | null {
    const row = this.rows.get(where.id);
    return row ? { ...row } : null;
  }

  // Prisma 的 update 返回 Promise（syncFromProjection 会链式调用 .catch），stub 必须一致
  async update({
    where,
    data,
  }: {
    where: { id: string };
    data: Partial<RunRecord>;
  }): Promise<RunRecord> {
    const row = this.rows.get(where.id);
    if (!row) throw new Error(`run not found: ${where.id}`);
    Object.assign(row, data);
    return { ...row };
  }
}

function makeSetup(llmStub: unknown): {
  engine: EngineService;
  eventStore: MemoryEventStore;
  runsService: RunsService;
} {
  const definition = linearDefinition(
    [
      node('start', 'start'),
      node('llm_1', 'llm', { provider: 'p', model: 'm', prompt: '你好' }),
      node('end', 'end'),
    ],
    [
      { id: 'e1', source: 'start', target: 'llm_1' },
      { id: 'e2', source: 'llm_1', target: 'end' },
    ],
  );
  const eventStore = new MemoryEventStore();
  const prismaStub = {
    workflowRun: new InMemoryRunModel(),
    workflow: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'wf_1'
          ? { id: 'wf_1', version: 1, definition: JSON.stringify(definition) }
          : null,
    },
  } as unknown as PrismaService;
  const runsService = new RunsService(prismaStub, eventStore as unknown as EventStore);
  const engine = new EngineService(
    prismaStub,
    eventStore as unknown as EventStore,
    llmStub as LlmAdapter,
    {} as McpRegistryService,
    runsService,
  );
  // 与 EngineModule.onModuleInit 相同的桥接：启动回调 + 控制面意图查询
  runsService.setRunStarter((runId) => engine.execute(runId));
  runsService.setControlIntentProvider((runId) => engine.getControlIntent(runId));
  return { engine, eventStore, runsService };
}

async function waitForEvent(
  eventStore: MemoryEventStore,
  runId: string,
  type: WorkflowEvent['type'],
): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const events = await eventStore.readEvents(runId);
    if (events.some((event) => event.type === type)) return;
    if (Date.now() >= deadline) throw new Error(`等待事件 ${type} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCond(predicate: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('暂停/取消意图暴露（run summary/详情 DTO）', () => {
  it('运行中请求暂停 → summary.pauseRequested=true → 节点结束后 RUN_SUSPENDED 且标志消失', async () => {
    let resolveLlm!: (value: { content: string }) => void;
    const gate = new Promise<{ content: string }>((resolve) => {
      resolveLlm = resolve;
    });
    const { engine, eventStore, runsService } = makeSetup({ chatCompletion: () => gate });

    const runId = await runsService.startRun('wf_1', null);
    await waitForEvent(eventStore, runId, 'NODE_STARTED');

    await engine.pause(runId);
    const pending = await runsService.getRun(runId);
    expect(pending.pauseRequested).toBe(true);

    resolveLlm({ content: 'ok' });
    await waitForEvent(eventStore, runId, 'RUN_SUSPENDED');
    // 引擎退出（finally 清理意图标志）是异步收尾，轮询等标志消失
    await waitForCond(
      async () => (await runsService.getRun(runId)).pauseRequested === undefined,
      'pauseRequested 标志消失',
    );

    const settled = await runsService.getRun(runId);
    expect(settled.status).toBe('suspended');
    expect(settled.pauseRequested).toBeUndefined();
    const suspended = (await eventStore.readEvents(runId)).find(
      (event) => event.type === 'RUN_SUSPENDED',
    );
    expect((suspended?.payload as { reason?: string } | undefined)?.reason).toBe('paused');
  });

  it('运行中请求取消 → summary.cancelRequested=true → 节点结束后 RUN_CANCELED 且标志消失', async () => {
    let resolveLlm!: (value: { content: string }) => void;
    const gate = new Promise<{ content: string }>((resolve) => {
      resolveLlm = resolve;
    });
    const { engine, eventStore, runsService } = makeSetup({ chatCompletion: () => gate });

    const runId = await runsService.startRun('wf_1', null);
    await waitForEvent(eventStore, runId, 'NODE_STARTED');

    await engine.cancel(runId);
    const pending = await runsService.getRun(runId);
    expect(pending.cancelRequested).toBe(true);

    resolveLlm({ content: 'ok' });
    await waitForEvent(eventStore, runId, 'RUN_CANCELED');
    await waitForCond(
      async () => (await runsService.getRun(runId)).cancelRequested === undefined,
      'cancelRequested 标志消失',
    );

    const settled = await runsService.getRun(runId);
    expect(settled.status).toBe('canceled');
    expect(settled.cancelRequested).toBeUndefined();
  });
});
