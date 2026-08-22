import { ConflictException } from '@nestjs/common';
import type { WorkflowEvent } from '@flowagent/shared';
import { describe, expect, it } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { EngineService } from '../src/engine/scheduler';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

/** 轮询事件流直至目标事件出现（≤2s，10ms 步进）；审批通过后引擎为异步执行，需等终态事件 */
async function waitForEvent(
  eventStore: MemoryEventStore,
  type: WorkflowEvent['type'],
): Promise<WorkflowEvent> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const events = await eventStore.readEvents('run_1');
    const found = events.find((event) => event.type === type);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`等待事件 ${type} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function humanFlowDefinition(): Record<string, unknown> {
  return linearDefinition(
    [
      node('start', 'start'),
      node('review', 'human', { prompt: '请审批发布' }),
      node('end', 'end', { outputs: { final: '{{review.output.verdict}}' } }),
    ],
    [
      { id: 'e1', source: 'start', target: 'review' },
      { id: 'e2', source: 'review', target: 'end' },
    ],
  );
}

async function suspendAtHuman(engine: EngineService): Promise<void> {
  await engine.execute('run_1');
}

describe('Human 挂起恢复', () => {
  it('批准后恢复执行，human 提交的 input 注入下游模板', async () => {
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, humanFlowDefinition());
    await suspendAtHuman(engine);

    await engine.submitHumanInput('run_1', { approved: true, input: { verdict: '通过' } });
    await waitForEvent(eventStore, 'RUN_COMPLETED');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.output).toEqual({ final: '通过' });

    // 恢复语义：审批事件 + RUN_RESUMED，且 human 节点不重复执行
    const types = events.map((event) => event.type);
    expect(types).toContain('HUMAN_INPUT_RECEIVED');
    expect(types).toContain('RUN_RESUMED');
    const reviewStarts = events.filter(
      (event) => event.type === 'NODE_STARTED' && (event.payload as { nodeId?: string }).nodeId === 'review',
    );
    expect(reviewStarts).toHaveLength(1);
  });

  it('批准后恢复执行，human 节点投影为 succeeded（不再卡 running）', async () => {
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, humanFlowDefinition());
    await suspendAtHuman(engine);

    await engine.submitHumanInput('run_1', { approved: true, input: { verdict: '通过' } });
    await waitForEvent(eventStore, 'RUN_COMPLETED');

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('completed');
    expect(state.nodes.get('review')?.status).toBe('succeeded');
    expect(state.nodes.get('review')?.output).toEqual({ verdict: '通过' });
  });

  it('拒绝审批 → NODE_FAILED + RUN_FAILED，不重入引擎', async () => {
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, humanFlowDefinition());
    await suspendAtHuman(engine);

    await engine.submitHumanInput('run_1', { approved: false });

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('failed');
    expect(state.error).toContain('审批被拒绝');
    expect(events.map((event) => event.type)).not.toContain('RUN_RESUMED');
    expect(state.nodes.get('review')?.status).toBe('failed');
  });

  it('条件菱形分支挂起 human 后恢复：汇合 end 正常执行，run 输出非 null（killSubtree 双扣回归）', async () => {
    // start → cond →(hi) human →(拒绝侧剪枝) 独立节点，两条路径汇合到 end：
    // 回放时 cond 剪枝与 skipped 节点各触发一次 killSubtree，去重前 end 入度被双扣为 -1 永不 ready
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('cond', 'condition', {
          branches: [
            { id: 'hi', expression: 'true' },
            { id: 'lo', expression: 'false' },
          ],
        }),
        node('review', 'human', { prompt: '请审批' }),
        node('lo_path', 'transform', { template: { path: 'lo' } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'review', sourceHandle: 'hi' },
        { id: 'e3', source: 'cond', target: 'lo_path', sourceHandle: 'lo' },
        { id: 'e4', source: 'review', target: 'end' },
        { id: 'e5', source: 'lo_path', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');

    await engine.submitHumanInput('run_1', { approved: true, input: { verdict: '通过' } });
    await waitForEvent(eventStore, 'RUN_COMPLETED');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.nodes.get('end')?.status).toBe('succeeded');
    expect(state.nodes.get('lo_path')?.status).toBe('skipped');
    // end 未配置 outputs 时取最后上游（human input）输出
    expect(state.output).toEqual({ verdict: '通过' });
  });

  it('非 waiting_human 状态提交审批 → 409 冲突', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('end', 'end')],
      [{ id: 'e1', source: 'start', target: 'end' }],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');

    await expect(
      engine.submitHumanInput('run_1', { approved: true, input: null }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
