/**
 * 回放用轻量事件折叠：只关注节点/运行状态相关事件。
 * server 端完整投影在 apps/server 内（暂不跨包引用），此处为回放时间轴的降级版。
 */
import type { WorkflowEvent } from '@flowagent/shared';

export interface ReplayNodeState {
  nodeId: string;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'suspended';
  error?: string;
}

export interface ReplayState {
  status: string;
  nodes: Map<string, ReplayNodeState>;
}

export function foldReplayState(events: WorkflowEvent[]): ReplayState {
  const nodes = new Map<string, ReplayNodeState>();
  let status = 'pending';
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null;
    const node = nodeId ? (nodes.get(nodeId) ?? { nodeId, status: 'idle' as const }) : null;
    switch (event.type) {
      case 'RUN_STARTED':
      case 'RUN_RESUMED':
        status = 'running';
        break;
      case 'NODE_STARTED':
        if (node) nodes.set(nodeId!, { ...node, status: 'running' });
        break;
      case 'NODE_SUCCEEDED':
        if (node) nodes.set(nodeId!, { ...node, status: 'succeeded' });
        break;
      case 'NODE_FAILED':
        if (node)
          nodes.set(nodeId!, { ...node, status: 'failed', error: String(payload.error ?? '') });
        break;
      case 'NODE_SKIPPED':
        if (node) nodes.set(nodeId!, { ...node, status: 'skipped' });
        break;
      case 'HUMAN_WAITING':
        if (node) nodes.set(nodeId!, { ...node, status: 'suspended' });
        status = 'waiting_human';
        break;
      case 'HUMAN_INPUT_RECEIVED':
        if (node) nodes.set(nodeId!, { ...node, status: 'running' });
        status = 'running';
        break;
      case 'RUN_SUSPENDED':
        if (status !== 'waiting_human') status = 'suspended';
        break;
      case 'RUN_COMPLETED':
        status = 'completed';
        break;
      case 'RUN_FAILED':
        status = 'failed';
        break;
      case 'RUN_CANCELED':
        status = 'canceled';
        break;
      default:
        break;
    }
  }
  return { status, nodes };
}
