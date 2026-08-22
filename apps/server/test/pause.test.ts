import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { MemoryEventStore, engineFlags, linearDefinition, makeEngine, node } from './engine-harness';

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
    engineFlags(engine).pauseRequested.add('run_1');

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
    engineFlags(engine).pauseRequested.add('run_1');
    await engine.execute('run_1');

    await engine.resume('run_1');

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
