/** 引擎单测共享基建：内存 EventStore + 内存 Prisma 的 EngineService 工厂 */
import type { WorkflowEvent } from '@flowagent/shared';

import { EngineService } from '../src/engine/scheduler';
import { LlmAdapter } from '../src/llm/llm.adapter';
import { McpRegistryService } from '../src/mcp/mcp.registry';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunsService } from '../src/runs/runs.service';
import { EventStore } from '../src/engine/event-store.service';

export class MemoryEventStore {
  events: WorkflowEvent[] = [];

  async append(
    runId: string,
    seq: number,
    type: WorkflowEvent['type'],
    payload: unknown,
  ): Promise<WorkflowEvent> {
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
  async readEvents(runId: string, fromSeq = 0): Promise<WorkflowEvent[]> {
    return this.events
      .filter((event) => event.runId === runId && event.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
  }
  async nextSeq(runId: string): Promise<number> {
    const forRun = this.events.filter((event) => event.runId === runId);
    return (forRun.at(-1)?.seq ?? 0) + 1;
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

/** 访问引擎私有标志集合（暂停/取消测试用） */
export function engineFlags(engine: EngineService): {
  pauseRequested: Set<string>;
  cancelRequested: Set<string>;
} {
  return engine as unknown as {
    pauseRequested: Set<string>;
    cancelRequested: Set<string>;
  };
}
