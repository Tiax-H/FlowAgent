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
