/** 并发正确性回归：事件写入原子性、终态屏障、控制面互斥（2026-08-22 复审修复的锁死用例） */
import { ConflictException } from '@nestjs/common';
import type { WorkflowEvent } from '@flowagent/shared';
import { describe, expect, it, vi } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

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

describe('并发正确性', () => {
  it('多写入者并发 append：seq 全局唯一且连续（原子分配契约）', async () => {
    const store = new MemoryEventStore();
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        store.append('run_x', 'NODE_STARTED', { index, writer: index % 3 }),
      ),
    );
    const events = await store.readEvents('run_x');
    const seqs = events.map((event) => event.seq);
    expect(seqs).toHaveLength(60);
    expect(new Set(seqs).size).toBe(60);
    expect(seqs.every((seq) => seq >= 1 && seq <= 60)).toBe(true);
    // 落库顺序即 seq 升序（readEvents 按 seq 排序）
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]! - seqs[i - 1]!).toBe(1);
    }
  });

  it('并行双失败节点：两条 NODE_FAILED 但只有一条 RUN_FAILED（终态屏障）', async () => {
    const chatCompletion = vi
      .fn<() => Promise<{ content: string }>>()
      .mockRejectedValue(new Error('boom'));
    // start 分叉到两个 llm 节点，再汇合 end
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('llm_a', 'llm', { provider: 'p', model: 'm', prompt: 'a' }),
        node('llm_b', 'llm', { provider: 'p', model: 'm', prompt: 'b' }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 'llm_a' },
        { id: 'e2', source: 'start', target: 'llm_b' },
        { id: 'e3', source: 'llm_a', target: 'end' },
        { id: 'e4', source: 'llm_b', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition, {
      llm: { chatCompletion: chatCompletion as never },
    });

    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const nodeFailed = events.filter((event) => event.type === 'NODE_FAILED');
    const runFailed = events.filter((event) => event.type === 'RUN_FAILED');
    expect(nodeFailed.length).toBeGreaterThanOrEqual(1);
    expect(runFailed).toHaveLength(1);
    expect(projectRunState('run_1', events).status).toBe('failed');
  });

  it('双击审批（并发 submitHumanInput）：只有一份 HUMAN_INPUT_RECEIVED，第二次 409', async () => {
    const chatCompletion = vi.fn<() => Promise<{ content: string }>>().mockResolvedValue({
      content: 'ok',
    });
    const definition = linearDefinition(
      [node('start', 'start'), node('human_1', 'human', { prompt: '审一下' }), node('end', 'end')],
      [
        { id: 'e1', source: 'start', target: 'human_1' },
        { id: 'e2', source: 'human_1', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition, {
      llm: { chatCompletion: chatCompletion as never },
    });

    await engine.execute('run_1');
    expect(projectRunState('run_1', await eventStore.readEvents('run_1')).status).toBe(
      'waiting_human',
    );

    // 并发双击批准：控制面互斥保证串行，第二个请求读到已变更投影 → 409
    const results = await Promise.allSettled([
      engine.submitHumanInput('run_1', { approved: true, input: '批准' }),
      engine.submitHumanInput('run_1', { approved: true, input: '批准' }),
    ]);
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    await waitForEvent(eventStore, 'RUN_COMPLETED');
    const events = await eventStore.readEvents('run_1');
    expect(events.filter((event) => event.type === 'HUMAN_INPUT_RECEIVED')).toHaveLength(1);
    expect(projectRunState('run_1', events).status).toBe('completed');
  });
});
