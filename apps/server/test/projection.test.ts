import { describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '@flowagent/shared';

import { applyEvent, emptyRunState, projectRunState } from '../src/engine/projection';

function event(
  seq: number,
  type: WorkflowEvent['type'],
  payload: Record<string, unknown> = {},
): WorkflowEvent {
  return {
    runId: 'run_1',
    seq,
    type,
    payload,
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  };
}

describe('projectRunState', () => {
  it('完整生命周期回放：started → 节点成功 → completed', () => {
    const events = [
      event(1, 'RUN_STARTED', { workflowId: 'wf1', input: { q: 'x' } }),
      event(2, 'NODE_STARTED', { nodeId: 'start', nodeType: 'start' }),
      event(3, 'NODE_SUCCEEDED', { nodeId: 'start', nodeType: 'start', output: { q: 'x' } }),
      event(4, 'RUN_COMPLETED', { output: { ok: true } }),
    ];
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('completed');
    expect(state.lastSeq).toBe(4);
    expect(state.nodes.get('start')?.status).toBe('succeeded');
    expect(state.output).toEqual({ ok: true });
    expect(state.startedAt).not.toBeNull();
    expect(state.endedAt).not.toBeNull();
  });

  it('节点失败 → RUN_FAILED，error 透传', () => {
    const events = [
      event(1, 'RUN_STARTED'),
      event(2, 'NODE_STARTED', { nodeId: 'agent', nodeType: 'agent' }),
      event(3, 'NODE_FAILED', { nodeId: 'agent', nodeType: 'agent', error: '超时' }),
      event(4, 'RUN_FAILED', { error: '超时' }),
    ];
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('failed');
    expect(state.nodes.get('agent')?.status).toBe('failed');
    expect(state.nodes.get('agent')?.error).toBe('超时');
    expect(state.error).toBe('超时');
  });

  it('Human 挂起：HUMAN_WAITING → waiting_human，恢复后 running', () => {
    const events = [
      event(1, 'RUN_STARTED'),
      event(2, 'HUMAN_WAITING', { nodeId: 'review', nodeType: 'human', prompt: '请审批' }),
      event(3, 'RUN_SUSPENDED'),
    ];
    const state = projectRunState('run_1', events);
    expect(state.status).toBe('waiting_human');
    expect(state.waitingHumanNodeId).toBe('review');
    expect(state.nodes.get('review')?.status).toBe('suspended');

    const resumed = projectRunState('run_1', [
      ...events,
      event(4, 'HUMAN_INPUT_RECEIVED', { nodeId: 'review', approved: true }),
      event(5, 'RUN_RESUMED'),
    ]);
    expect(resumed.status).toBe('running');
    expect(resumed.waitingHumanNodeId).toBeNull();
  });

  it('applyEvent 不修改原状态（纯函数）', () => {
    const initial = emptyRunState('run_1');
    const next = applyEvent(initial, event(1, 'RUN_STARTED'));
    expect(initial.status).toBe('pending');
    expect(next.status).toBe('running');
    expect(next.nodes).not.toBe(initial.nodes);
  });

  it('空事件序列 → pending 初始态', () => {
    const state = projectRunState('run_1', []);
    expect(state.status).toBe('pending');
    expect(state.lastSeq).toBe(0);
  });
});
