import { describe, expect, it, vi } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

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
    const engine = makeEngine(eventStore, definition, { input: { name: 'FlowAgent' } });
    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const types = events.map((event) => event.type);
    expect(types).toContain('NODE_STARTED');
    expect(types).toContain('NODE_SUCCEEDED');
    expect(types).toContain('RUN_COMPLETED');
    expect(types).toContain('CHECKPOINT_SAVED');

    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.nodes.get('t1')?.output).toEqual({ greeting: '你好 FlowAgent' });
  });

  it('并行分支：两个中间节点都被执行', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('a', 'transform', { template: { r: 'A' } }),
        node('b', 'transform', { template: { r: 'B' } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'start', target: 'b' },
        { id: 'e3', source: 'a', target: 'end' },
        { id: 'e4', source: 'b', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('completed');
    expect(state.nodes.get('a')?.status).toBe('succeeded');
    expect(state.nodes.get('b')?.status).toBe('succeeded');
  });

  it('Condition 选分支：未选分支下游被 SKIPPED', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('cond', 'condition', {
          branches: [
            { id: 'hi', expression: 'input.score > 0.5' },
            { id: 'lo', expression: 'true' },
          ],
        }),
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
    const engine = makeEngine(eventStore, definition, { input: { score: 0.9 } });
    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.nodes.get('hi_path')?.status).toBe('succeeded');
    expect(state.nodes.get('lo_path')?.status).toBe('skipped');
  });

  it('节点失败 → RUN_FAILED，其余节点不再调度', async () => {
    // 用 LLM 拒答模拟运行时失败（空模板 transform 现在在校验层即被拒，属快速失败）
    const chatCompletion = vi
      .fn<() => Promise<{ content: string }>>()
      .mockRejectedValue(new Error('上游 500'));
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('boom', 'llm', { provider: 'p', model: 'm', prompt: 'hi' }),
        node('after', 'transform', { template: { x: 1 } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 'boom' },
        { id: 'e2', source: 'boom', target: 'after' },
        { id: 'e3', source: 'after', target: 'end' },
      ],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition, {
      llm: { chatCompletion: chatCompletion as never },
    });
    await engine.execute('run_1');

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
    await engine.execute('run_1');

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
    await engine.execute('run_1');

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
    await engine.execute('run_1');

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('completed');
    const loopOutput = state.nodes.get('loop_1')?.output as {
      iterations: number;
      results: unknown[];
    };
    expect(loopOutput.iterations).toBe(3);
    expect(loopOutput.results).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
  });

  it('终态 run 重入 execute 幂等返回，不产生新事件', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('end', 'end')],
      [{ id: 'e1', source: 'start', target: 'end' }],
    );

    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');
    const countAfterFirst = (await eventStore.readEvents('run_1')).length;

    await engine.execute('run_1');
    expect((await eventStore.readEvents('run_1')).length).toBe(countAfterFirst);
  });
});
