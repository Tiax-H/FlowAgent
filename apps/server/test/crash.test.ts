import type { WorkflowEvent } from '@flowagent/shared';
import { describe, expect, it, vi } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

/** 轮询事件流直至目标事件出现（≤2s，10ms 步进）；retryFailed 为异步执行，需等终态事件 */
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

describe('崩溃恢复与失败断点重试', () => {
  it('中途崩溃后重入 execute：只执行剩余节点，不重跑已完成节点', async () => {
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('t1', 'transform', { template: { greeting: '你好' } }),
        node('t2', 'transform', { template: { echo: '{{t1.output.greeting}} 世界' } }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 't1' },
        { id: 'e2', source: 't1', target: 't2' },
        { id: 'e3', source: 't2', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();

    // 手工构造「崩溃前」的事件流：start 与 t1 已完成，t2 未开始
    await eventStore.append('run_1', 1, 'RUN_STARTED', { workflowId: 'wf_1', input: null });
    await eventStore.append('run_1', 2, 'NODE_STARTED', { nodeId: 'start', nodeType: 'start' });
    await eventStore.append('run_1', 3, 'NODE_SUCCEEDED', {
      nodeId: 'start',
      nodeType: 'start',
      output: null,
    });
    await eventStore.append('run_1', 4, 'NODE_STARTED', { nodeId: 't1', nodeType: 'transform' });
    await eventStore.append('run_1', 5, 'NODE_SUCCEEDED', {
      nodeId: 't1',
      nodeType: 'transform',
      output: { greeting: '你好' },
    });

    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    // 已完成节点不重跑
    const t1Starts = events.filter(
      (event) => event.type === 'NODE_STARTED' && (event.payload as { nodeId?: string }).nodeId === 't1',
    );
    expect(t1Starts).toHaveLength(1);
    // 剩余节点从重建的 nodeOutputs 继续渲染
    expect(state.nodes.get('t2')?.output).toEqual({ echo: '你好 世界' });
  });

  it('崩溃残留的 running 节点按断点重跑语义重新执行', async () => {
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
    // start 已完成，t1 只发了 NODE_STARTED 即崩溃
    await eventStore.append('run_1', 1, 'RUN_STARTED', { workflowId: 'wf_1', input: null });
    await eventStore.append('run_1', 2, 'NODE_STARTED', { nodeId: 'start', nodeType: 'start' });
    await eventStore.append('run_1', 3, 'NODE_SUCCEEDED', {
      nodeId: 'start',
      nodeType: 'start',
      output: null,
    });
    await eventStore.append('run_1', 4, 'NODE_STARTED', { nodeId: 't1', nodeType: 'transform' });

    const engine = makeEngine(eventStore, definition);
    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.nodes.get('t1')?.output).toEqual({ x: 1 });
  });

  it('retry_failed 模式：failed 节点被重新武装，成功后 completed', async () => {
    const chatCompletion = vi
      .fn<() => Promise<{ content: string }>>()
      .mockRejectedValueOnce(new Error('首次失败'))
      .mockResolvedValue({ content: 'ok' });
    const definition = linearDefinition(
      [
        node('start', 'start'),
        node('llm_1', 'llm', { provider: 'p', model: 'm', prompt: 'hi' }),
        node('end', 'end'),
      ],
      [
        { id: 'e1', source: 'start', target: 'llm_1' },
        { id: 'e2', source: 'llm_1', target: 'end' },
      ],
    );
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, definition, { llm: { chatCompletion: chatCompletion as never } });

    await engine.execute('run_1');
    expect(projectRunState('run_1', await eventStore.readEvents('run_1')).status).toBe('failed');

    await engine.retryFailed('run_1');
    await waitForEvent(eventStore, 'RUN_COMPLETED');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.output).toEqual({ text: 'ok' });
    const llmStarts = events.filter(
      (event) => event.type === 'NODE_STARTED' && (event.payload as { nodeId?: string }).nodeId === 'llm_1',
    );
    expect(llmStarts).toHaveLength(2);
    const resumed = events.filter((event) => event.type === 'RUN_RESUMED');
    expect((resumed[0]?.payload as { mode?: string } | undefined)?.mode).toBe('retry_failed');
  });
});
