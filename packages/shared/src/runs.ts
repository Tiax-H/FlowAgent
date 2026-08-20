/** Runs API 的响应类型（前后端共享） */

export interface RunNodeSummary {
  nodeId: string;
  nodeType: string;
  name: string;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'suspended';
  error?: string;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  nodes: RunNodeSummary[];
  startedAt: string | null;
  endedAt: string | null;
}
