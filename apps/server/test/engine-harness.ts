/** 引擎单测共享基建：内存 EventStore + 内存 Prisma 的 EngineService 工厂 */
import type { WorkflowEvent } from '@flowagent/shared';

import { EngineService } from '../src/engine/scheduler';
import { LlmAdapter } from '../src/llm/llm.adapter';
import { McpRegistryService } from '../src/mcp/mcp.registry';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunsService } from '../src/runs/runs.service';
import { EventStore } from '../src/engine/event-store.service';

/**
 * 内存 EventStore：与真实现的并发契约一致——
 * per-run 串行队列内原子分配 seq（等价 SQLite 的 (runId,seq) 唯一约束 + nextSeq）。
 * 并发写入者（调度器 emit 与控制面）不会撞号，撞号即抛错让测试失败。
 */
export class MemoryEventStore {
  events: WorkflowEvent[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();

  private enqueue<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private nextSeqOf(runId: string): number {
    let max = 0;
    for (const event of this.events) {
      if (event.runId === runId && event.seq > max) max = event.seq;
    }
    return max + 1;
  }

  append(
    runId: string,
    type: WorkflowEvent['type'],
    payload: unknown,
  ): Promise<WorkflowEvent> {
    return this.enqueue(runId, () => this.appendDirect(runId, type, payload));
  }

  async readEvents(runId: string, fromSeq = 0): Promise<WorkflowEvent[]> {
    return this.events
      .filter((event) => event.runId === runId && event.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  /** 与真实现同语义的终态屏障：流内已终态则跳过（返回 null） */
  appendTerminal(
    runId: string,
    type: WorkflowEvent['type'],
    payload: unknown,
  ): Promise<WorkflowEvent | null> {
    return this.enqueue(runId, async () => {
      const sorted = await this.readEvents(runId);
      const last = sorted.at(-1);
      if (
        last &&
        ['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELED'].includes(last.type)
      ) {
        return null;
      }
      return this.appendDirect(runId, type, payload);
    });
  }

  /** 队列临界区内直接落事件（不再重新排队） */
  private async appendDirect(
    runId: string,
    type: WorkflowEvent['type'],
    payload: unknown,
  ): Promise<WorkflowEvent> {
    const seq = this.nextSeqOf(runId);
    const event: WorkflowEvent = {
      id: this.events.length + 1,
      runId,
      seq,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  async nextSeq(runId: string): Promise<number> {
    return this.nextSeqOf(runId);
  }
}

export function linearDefinition(nodes: unknown[], edges: unknown[]): Record<string, unknown> {
  return { schemaVersion: 1, nodes, edges };
}

export function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
) {
  return { id, type, name: id, position, data };
}

export interface EngineHarnessOptions {
  input?: unknown;
  /** LLM stub（llm/agent 节点用），如 { chatCompletion: async () => ({ content: '...' }) } */
  llm?: Partial<LlmAdapter>;
}

/* 内存 Prisma + 真 EngineService。用例只覆盖模板/条件/挂起/Loop/LLM-stub 路径，
   不触碰 MCP（其 stub 经构造注入永不触发）。 */
export function makeEngine(
  eventStore: MemoryEventStore,
  definition: unknown,
  options: EngineHarnessOptions = {},
): EngineService {
  const runRow = {
    id: 'run_1',
    workflowId: 'wf_1',
    input: JSON.stringify(options.input ?? null),
    definitionSnapshot: JSON.stringify(definition),
  };
  const workflows = new Map([['wf_1', { id: 'wf_1', definition: JSON.stringify(definition) }]]);
  const prismaStub = {
    workflowRun: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'run_1' ? runRow : null,
    },
    workflow: {
      findUnique: async ({ where }: { where: { id: string } }) => workflows.get(where.id) ?? null,
    },
    mcpTool: { findMany: async () => [] },
  } as unknown as PrismaService;
  const runsStub = {
    syncFromProjection: async () => undefined,
    ensureRun: async () => runRow,
  } as unknown as RunsService;

  return new EngineService(
    prismaStub,
    eventStore as unknown as EventStore,
    (options.llm ?? {}) as LlmAdapter,
    {} as McpRegistryService,
    runsStub,
  );
}

/** 访问引擎私有意图标志（暂停/取消测试用）：runId -> 纪元 */
export function engineFlags(engine: EngineService): {
  pauseRequested: Map<string, number>;
  cancelRequested: Map<string, number>;
} {
  return engine as unknown as {
    pauseRequested: Map<string, number>;
    cancelRequested: Map<string, number>;
  };
}
