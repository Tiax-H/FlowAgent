/** Runs API 的响应类型（前后端共享） */

export interface RunNodeSummary {
  nodeId: string;
  nodeType: string;
  name: string;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'suspended';
  error?: string;
}

/** 运行中等待人工介入的节点摘要（供前端渲染审批表单） */
export interface RunWaitingHuman {
  nodeId: string;
  nodeType: string;
  name: string;
  prompt: string;
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
  /** status 为 waiting_human 时非空 */
  waitingHuman: RunWaitingHuman | null;
}

/** Human 节点审批/补充输入请求体 */
export interface HumanInputRequest {
  approved: boolean;
  input?: unknown;
}
