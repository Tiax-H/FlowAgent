import type { ErrorClassificationFields, RunSummary } from '@flowagent/shared';

export interface WorkflowSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
}

/**
 * 后端逐步上线的可选字段（前端按契约预接，字段缺省时行为不变）：
 * - pauseRequested / cancelRequested：暂停/取消请求已被受理、等待当前节点结束后生效
 * - workflowDeleted：原工作流已被删除，此运行基于历史定义快照
 */
export type RunSummaryWithFlags = RunSummary & {
  pauseRequested?: boolean;
  cancelRequested?: boolean;
  workflowDeleted?: boolean;
};

/** 后端未上线 workflowDeleted 字段时，workflowName 会以该兜底值标记孤儿运行 */
export const WORKFLOW_DELETED_NAME_FALLBACK = '(已删除)';

/** 失败事件 payload 的错误分层字段（与 @flowagent/shared 的 ErrorClassificationFields 对齐，另含原始 error） */
export type FailurePayloadExtras = ErrorClassificationFields & { error?: string };

