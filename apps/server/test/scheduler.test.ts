import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent } from '@flowagent/shared';

import { EngineService } from '../src/engine/scheduler';
import { LlmAdapter } from '../src/llm/llm.adapter';
import { McpRegistryService } from '../src/mcp/mcp.registry';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunsService } from '../src/runs/runs.service';
import { EventStore } from '../src/engine/event-store.service';
import { projectRunState } from '../src/engine/projection';

/* ---------------- 测试基建：内存 EventStore ---------------- */

class MemoryEventStore {
  events: WorkflowEvent[] = [];

  async append(runId: string, seq: number, type: WorkflowEvent['type'], payload: unknown): Promise<WorkflowEvent> {
    const event: WorkflowEvent = { id: this.events.length + 1, runId, seq, type, payload, timestamp: new Date().toISOString() };
    this.events.push(event);
    return event;
  }
  async readEvents(runId: string, fromSeq = 0): Promise<WorkflowEvent[]> {
    return this.events.filter((event) => event.runId === runId && event.seq > fromSeq).sort((a, b) => a.seq - b.seq);
  }
  async nextSeq(runId: string): Promise<number> {
    const forRun = this.events.filter((event) => event.runId === runId);
    return (forRun.at(-1)?.seq ?? 0) + 1;
  }
}

vi.mock('../src/runs/runs.service', () => ({
  RunsService: class {
    async syncFromProjection(): Promise<void> {}
  },
}));

/* ---------------- 工具函数 ---------------- */

function linearDefinition(nodes: unknown[], edges: unknown[]): Record<string, unknown> {
  return { schemaVersion: 1, nodes, edges };
}

function node(id: string, type: string, data: Record<string, unknown> = {}, position = { x: 0, y: 0 }) {
  return { id, type, name: id, position, data };
}

/* ---------------- 用例 ---------------- */

describe('EngineService 调度器', () => {
  it('线性 start→transform→end 完整执行并产出输出', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('t1', 'transform', { template: { greeting: '你好 {{input.name}}' } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 't1' },
        { id: 'e2', source: 't1', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', { name: 'FlowAgent' });

    const events = await eventStore.readEvents('run_1');
    const types = events.map((event) => event.type);
    expect(types).toContain('NODE_STARTED');
    expect(types).toContain('NODE_SUCCEEDED');
    expect(types).toContain('RUN_COMPLETED');

    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.nodes.get('t1')?.output).toEqual({ greeting: '你好 FlowAgent' });
  });

  it('并行分支：两个中间节点都被执行', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('a', 'transform', { template: { r: 'A' } }), node('b', 'transform', { template: { r: 'B' } }), node('end', 'end')],
      [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'start', target: 'b' },
        { id: 'e3', source: 'a', target: 'end' },
        { id: 'e4', source: 'b', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', null);

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('completed');
    expect(state.nodes.get('a')?.status).toBe('succeeded');
    expect(state.nodes.get('b')?.status).toBe('succeeded');
  });

  it('Condition 选分支：未选分支下游被 SKIPPED', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('cond', 'condition', { branches: [{ id: 'hi', expression: 'input.score > 0.5' }, { id: 'lo', expression: 'true' }] }),
        node('hi_path', 'transform', { template: { path: 'hi' } }),
        node('lo_path', 'transform', { template: { path: 'lo' } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'hi_path', sourceHandle: 'hi' },
        { id: 'e3', source: 'cond', target: 'lo_path', sourceHandle: 'lo' },
        { id: 'e4', source: 'hi_path', target: 'end' },
        { id: 'e5', source: 'lo_path', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', { score: 0.9 });

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.nodes.get('hi_path')?.status).toBe('succeeded');
    expect(state.nodes.get('lo_path')?.status).toBe('skipped');
  });

  it('节点失败 → RUN_FAILED，其余节点不再调度', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('boom', 'transform', {}), node('after', 'transform', { template: { x: 1 } }), node('end', 'end')],
      [
        { id: 'e1', source: 'start', target: 'boom' },
        { id: 'e2', source: 'boom', target: 'after' },
        { id: 'e3', source: 'after', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', null);

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('failed');
    expect(state.nodes.get('boom')?.status).toBe('failed');
    expect(state.nodes.get('after')?.status).toBeUndefined();
  });

  it('Human 节点 → RUN_SUSPENDED，状态 waiting_human', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('review', 'human', { prompt: '请审批' }), node('end', 'end')],
      [
        { id: 'e1', source: 'start', target: 'review' },
        { id: 'e2', source: 'review', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', null);

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('waiting_human');
    expect(state.waitingHumanNodeId).toBe('review');
    expect(state.nodes.get('end')?.status).toBeUndefined();
  });

  it('非法定义（成环）在引擎侧被拒：RUN_FAILED', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('a', 'transform', { template: {} }), node('end', 'end')],
      [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'end' },
        { id: 'e3', source: 'end', target: 'a' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', null);

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('failed');
    expect(state.error).toContain('DAG');
  });

  it('Loop 子图迭代：按集合逐项执行', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('t_items', 'transform', { template: { list: ['a', 'b', 'c'] } }),
        node('loop_1', 'loop', {
          maxIterations: 5,
          collection: '{{t_items.output.list}}',
          itemVariable: 'item',
          subgraph: {
            nodes: [node('body', 'transform', { template: { v: '{{loop.item}}' } })],
            edges: [],
          },
        }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 't_items' },
        { id: 'e2', source: 't_items', target: 'loop_1' },
        { id: 'e3', source: 'loop_1', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1', 'wf_1', null);

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('completed');
    const loopOutput = state.nodes.get('loop_1')?.output as { iterations: number; results: unknown[] };
    expect(loopOutput.iterations).toBe(3);
    expect(loopOutput.results).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
  });
});

/* 引擎工厂：内存 Prisma + 真 EngineService。
   用例只覆盖纯模板/条件/挂起/Loop 路径，不触碰 LLM/MCP（其 stub 经构造注入永不触发）。 */
function makeEngine(eventStore: MemoryEventStore, definition: unknown): EngineService {
  const workflows = new Map([['wf_1', { id: 'wf_1', definition: JSON.stringify(definition) }]]);
  const prismaStub = {
    workflow: { findUnique: async ({ where }: { where: { id: string } }) => workflows.get(where.id) ?? null },
    mcpTool: { findMany: async () => [] },
  } as unknown as PrismaService;
  const runsStub = { syncFromProjection: async () => undefined } as unknown as RunsService;

  const engine = new EngineService(
    prismaStub,
    eventStore as unknown as EventStore,
    {} as LlmAdapter,
    {} as McpRegistryService,
    runsStub,
  );
  return engine;
}
