/**
 * 事件溯源投影：纯函数，由事件序列重建运行/节点状态。
 *
 * 架构红线：引擎的可变状态只能通过事件投影获得，禁止旁路全局状态。
 */
import type { RunStatus, WorkflowEvent, WorkflowEventType } from '@flowagent/shared';

export interface ProjectedNodeState {
  nodeId: string;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'suspended';
  output?: unknown;
  error?: string;
  /** HUMAN_INPUT_RECEIVED 提交的输入（恢复时重建 Human 节点输出） */
  humanInput?: unknown;
  /** HUMAN_INPUT_RECEIVED 的审批结果 */
  approved?: boolean;
}

export interface ProjectedRunState {
  runId: string;
  status: RunStatus;
  /** 已消费的最大事件 seq */
  lastSeq: number;
  nodes: Map<string, ProjectedNodeState>;
  /** Human 挂起等待中的节点 id */
  waitingHumanNodeId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  output: unknown;
}

function eventPayload(event: WorkflowEvent): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

/** 单事件状态转移（fold）。供投影与增量更新共用。 */
export function applyEvent(state: ProjectedRunState, event: WorkflowEvent): ProjectedRunState {
  const payload = eventPayload(event);
  const next: ProjectedRunState = {
    ...state,
    lastSeq: event.seq,
    nodes: new Map(state.nodes),
  };

  const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null;
  const node = nodeId ? (next.nodes.get(nodeId) ?? { nodeId, status: 'idle' as const }) : null;

  switch (event.type as WorkflowEventType) {
    case 'RUN_STARTED':
      next.status = 'running';
      next.startedAt = event.timestamp;
      break;
    case 'NODE_STARTED':
      if (node) next.nodes.set(nodeId!, { ...node, status: 'running' });
      break;
    case 'NODE_SUCCEEDED':
      if (node) next.nodes.set(nodeId!, { ...node, status: 'succeeded', output: payload.output });
      break;
    case 'NODE_FAILED':
      if (node)
        next.nodes.set(nodeId!, { ...node, status: 'failed', error: String(payload.error ?? '') });
      break;
    case 'NODE_SKIPPED':
      if (node) next.nodes.set(nodeId!, { ...node, status: 'skipped' });
      break;
    case 'HUMAN_WAITING':
      if (node) next.nodes.set(nodeId!, { ...node, status: 'suspended' });
      next.status = 'waiting_human';
      next.waitingHumanNodeId = nodeId;
      break;
    case 'HUMAN_INPUT_RECEIVED':
      if (node)
        next.nodes.set(nodeId!, {
          ...node,
          status: 'running',
          humanInput: payload.input ?? null,
          approved: payload.approved === true,
        });
      next.status = 'running';
      next.waitingHumanNodeId = null;
      break;
    case 'RUN_SUSPENDED':
      if (next.status !== 'waiting_human') next.status = 'suspended';
      break;
    case 'RUN_RESUMED':
      next.status = 'running';
      break;
    case 'RUN_COMPLETED':
      next.status = 'completed';
      next.endedAt = event.timestamp;
      next.output = payload.output ?? null;
      break;
    case 'RUN_FAILED':
      next.status = 'failed';
      next.endedAt = event.timestamp;
      next.error = String(payload.error ?? '');
      break;
    case 'RUN_CANCELED':
      next.status = 'canceled';
      next.endedAt = event.timestamp;
      break;
    default:
      break;
  }

  return next;
}

export function emptyRunState(runId: string): ProjectedRunState {
  return {
    runId,
    status: 'pending',
    lastSeq: 0,
    nodes: new Map(),
    waitingHumanNodeId: null,
    startedAt: null,
    endedAt: null,
    error: null,
    output: null,
  };
}

/** 事件序列 → 运行状态（完整回放） */
export function projectRunState(runId: string, events: WorkflowEvent[]): ProjectedRunState {
  return events.reduce(applyEvent, emptyRunState(runId));
}

/** 终态判断：终态运行不可再 resume/pause */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}
