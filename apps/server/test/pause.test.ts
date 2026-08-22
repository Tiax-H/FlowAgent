import { ConflictException } from '@nestjs/common';
import type { WorkflowEvent } from '@flowagent/shared';
import { describe, expect, it } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { MemoryEventStore, engineFlags, linearDefinition, makeEngine, node } from './engine-harness';

/** 轮询事件流直至目标事件出现（≤2s，10ms 步进）；resume 为异步执行，需等终态事件 */
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

describe('主动暂停与取消', () => {
  it('调度前请求暂停 → RUN_SUSPENDED(paused)，无节点执行', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('t1', 'transform', { template: { x: 1 } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 't1' },
        { id: 'e2', source: 't1', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    engineFlags(engine).pauseRequested.set('run_1', 1);

    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('suspended');
    expect(events.map((event) => event.type)).not.toContain('NODE_STARTED');
    const suspended = events.find((event) => event.type === 'RUN_SUSPENDED');
    expect((suspended?.payload as { reason?: string } | undefined)?.reason).toBe('paused');
  });

  it('暂停后 resume → 从头跑完', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('t1', 'transform', { template: { x: '值' } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 't1' },
        { id: 'e2', source: 't1', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    engineFlags(engine).pauseRequested.set('run_1', 1);
    await engine.execute('run_1');

    await engine.resume('run_1');
    await waitForEvent(eventStore, 'RUN_COMPLETED');

    const state = projectRunState('run_1', await eventStore.readEvents('run_1'));
    expect(state.status).toBe('completed');
    expect(state.nodes.get('t1')?.output).toEqual({ x: '值' });
  });

  it('不在执行中的 run 调 pause → 409', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('end', 'end')],
      [{ id: 'e1', source: 'start', target: 'end' }],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await expect(engine.pause('run_1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('非挂起状态调 resume → 409', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('end', 'end')],
      [{ id: 'e1', source: 'start', target: 'end' }],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');
    await expect(engine.resume('run_1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('终态 run 调 cancel → 409；未启动 run 可直接取消', async () => {
    const definition = linearDefinition(
      [node('start', 'start'), node('end', 'end')],
      [{ id: 'e1', source: 'start', target: 'end' }],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');
    await expect(engine.cancel('run_1')).rejects.toBeInstanceOf(ConflictException);

    const freshStore = new MemoryEventStore();
    const freshEngine = makeEngine(freshStore, definition);
    await freshEngine.cancel('run_1');
    const state = projectRunState('run_1', await freshStore.readEvents('run_1'));
    expect(state.status).toBe('canceled');
  });
});
