import { describe, expect, it, vi } from 'vitest';

import { projectRunState } from '../src/engine/projection';
import { normalizeRetryPolicy, retryDelayMs } from '../src/engine/scheduler';
import { MemoryEventStore, linearDefinition, makeEngine, node } from './engine-harness';

function llmFlowDefinition(extra: Record<string, unknown>): Record<string, unknown> {
  // retry/timeoutMs 为节点顶层字段（WorkflowNodeBase），不进 data
  const llmNode = { ...node('llm_1', 'llm', { provider: 'p', model: 'm', prompt: 'hi' }), ...extra };
  return linearDefinition(
    [node('start', 'start'), llmNode, node('end', 'end')],
    [
      { id: 'e1', source: 'start', target: 'llm_1' },
      { id: 'e2', source: 'llm_1', target: 'end' },
    ],
  );
}

describe('节点超时与重试', () => {
  it('首次失败自动重试成功：发 NODE_RETRYING 后 completed', async () => {
    const chatCompletion = vi
      .fn<() => Promise<{ content: string }>>()
      .mockRejectedValueOnce(new Error('provider 500'))
      .mockResolvedValue({ content: 'recovered' });
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, llmFlowDefinition({ retry: { maxAttempts: 3, initialDelayMs: 1 } }), {
      llm: { chatCompletion: chatCompletion as never },
    });

    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.output).toEqual({ text: 'recovered' });
    expect(chatCompletion).toHaveBeenCalledTimes(2);

    const retrying = events.filter((event) => event.type === 'NODE_RETRYING');
    expect(retrying).toHaveLength(1);
    const payload = (retrying[0]?.payload ?? {}) as Record<string, number>;
    expect(payload.attempt).toBe(2);
    expect(payload.maxAttempts).toBe(3);
    expect(payload.delayMs).toBe(1);
  });

  it('重试耗尽 → NODE_FAILED + RUN_FAILED', async () => {
    const chatCompletion = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('持续失败'));
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(eventStore, llmFlowDefinition({ retry: { maxAttempts: 2, initialDelayMs: 1 } }), {
      llm: { chatCompletion: chatCompletion as never },
    });

    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('failed');
    expect(state.nodes.get('llm_1')?.status).toBe('failed');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'NODE_RETRYING')).toHaveLength(1);
  });

  it('timeoutMs 超时按失败尝试计入重试', async () => {
    const chatCompletion = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { content: 'late' };
    });
    const eventStore = new MemoryEventStore();
    const engine = makeEngine(
      eventStore,
      llmFlowDefinition({ timeoutMs: 10, retry: { maxAttempts: 2, initialDelayMs: 1 } }),
      { llm: { chatCompletion: chatCompletion as never } },
    );

    await engine.execute('run_1');

    const events = await eventStore.readEvents('run_1');
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('failed');
    expect(state.nodes.get('llm_1')?.error).toContain('执行超时');
  });

  it('retryDelayMs 指数退避序列与封顶', () => {
    const policy = normalizeRetryPolicy({ maxAttempts: 10 })!;
    expect(policy).toEqual({
      maxAttempts: 10,
      initialDelayMs: 500,
      backoffFactor: 2,
      maxDelayMs: 30_000,
    });
    expect(retryDelayMs(policy, 1)).toBe(500);
    expect(retryDelayMs(policy, 2)).toBe(1000);
    expect(retryDelayMs(policy, 3)).toBe(2000);
    expect(retryDelayMs(policy, 7)).toBe(30_000); // 32000 → 封顶
  });

  it('normalizeRetryPolicy：缺失/非法返回 null（只试一次）', () => {
    expect(normalizeRetryPolicy(undefined)).toBeNull();
    expect(normalizeRetryPolicy({ maxAttempts: 0 })).toBeNull();
    expect(normalizeRetryPolicy({ maxAttempts: -1 })).toBeNull();
    expect(normalizeRetryPolicy({ maxAttempts: 1, initialDelayMs: -5 })?.initialDelayMs).toBe(500);
  });
});
