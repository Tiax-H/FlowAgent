import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { EngineService } from '../src/engine/scheduler';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

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
