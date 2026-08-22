import type { WorkflowEvent } from '@flowagent/shared';
import { describe, expect, it } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

/** 轮询事件流直至目标事件出现（≤2s，10ms 步进） */
async function waitForEvent(
  eventStore: MemoryEventStore,
  runId: string,
  type: WorkflowEvent['type'],
): Promise<WorkflowEvent> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const events = await eventStore.readEvents(runId);
    const found = events.find((event) => event.type === type);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`等待事件 ${type} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('调度器重入竞态', () => {
  it('人审与慢节点并行：挂起窗口内提交审批不被丢弃，run 最终完成', async () => {
    const chatCompletion = async (): Promise<{ content: string }> => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { content: '慢节点完成' };
    };
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('review', 'human', { prompt: '请审批' }),
        node('llm_slow', 'llm', { provider: 'p', model: 'm', prompt: '慢' }),
        node('end', 'end', { outputs: { final: '{{review.output.verdict}}' } }),
      ],
      [
        { id: 'e1', source: 'start', target: 'review' },
        { id: 'e2', source: 'start', target: 'llm_slow' },
        { id: 'e3', source: 'review', target: 'end' },
        { id: 'e4', source: 'llm_slow', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition, {
      llm: { chatCompletion: chatCompletion as never },
    });

    const first = engine.execute('run_1');
    await waitForEvent(eventStore, 'run_1', 'HUMAN_WAITING');
    await engine.submitHumanInput('run_1', { approved: true, input: { verdict: '通过' } });
    await first;

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.output).toEqual({ final: '通过' });
  });
});
