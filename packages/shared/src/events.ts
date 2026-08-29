/**
 * 执行事件类型（事件溯源契约）。
 *
 * 事件不可变、只追加（append-only）；运行状态由事件投影得出。
 * 第 6-8 周的 Event Store 与前端回放时间轴直接消费这些类型。
 */

export const WORKFLOW_EVENT_TYPES = [
  'RUN_STARTED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_SUSPENDED',
  'RUN_RESUMED',
  'RUN_CANCELED',
  'NODE_STARTED',
  'NODE_SUCCEEDED',
  'NODE_FAILED',
  'NODE_SKIPPED',
  'NODE_RETRYING',
  'LLM_REQUESTED',
  'LLM_TOKEN',
  'LLM_COMPLETED',
  'TOOL_CALLED',
  'TOOL_RESULT',
  'HUMAN_WAITING',
  'HUMAN_INPUT_RECEIVED',
  'CHECKPOINT_SAVED',
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/** 运行状态（事件投影结果，不落可变字段） */
export const RUN_STATUS_VALUES = [
  'pending',
  'running',
  'suspended',
  'waiting_human',
  'completed',
  'failed',
  'canceled',
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export interface RunStartedPayload {
  workflowId: string;
  workflowVersion: number;
  input: unknown;
}

export interface NodePayloadBase {
  nodeId: string;
  nodeType: string;
}

/**
 * 错误归类扩展字段（全部可选，向后兼容旧事件）。
 *
 * `error` 一律为中文一句话摘要（不含上游原文与账号标识）；
 * 上游响应原文只允许以截断脱敏摘录进入 `upstreamExcerpt`（≤200 字符）。
 */
export interface ErrorClassificationFields {
  /** 机器可读归类：model_not_found / auth / rate_limited / upstream_error / timeout / network 等 */
  errorCategory?: string;
  /** 中文一句话提示，可直接展示给用户 */
  errorHint?: string;
  /** 上游响应原文截断脱敏摘录（≤200 字符），仅供诊断 */
  upstreamExcerpt?: string;
}

export interface NodeFailedPayload extends NodePayloadBase, ErrorClassificationFields {
  /** 中文一句话失败摘要（不含上游原文与账号标识） */
  error: string;
}

export interface NodeSucceededPayload extends NodePayloadBase {
  output: unknown;
}

export interface NodeRetryingPayload extends NodePayloadBase, ErrorClassificationFields {
  /** 即将执行的尝试序号（从 2 开始，1 为首次失败） */
  attempt: number;
  maxAttempts: number;
  /** 本次重试前的退避等待（毫秒） */
  delayMs: number;
  /** 中文一句话失败摘要（不含上游原文与账号标识） */
  error: string;
}

export interface RunFailedPayload extends ErrorClassificationFields {
  /** 中文一句话失败摘要（不含上游原文与账号标识） */
  error: string;
}

export interface LlmRequestedPayload extends NodePayloadBase {
  provider: string;
  model: string;
}

export interface LlmTokenPayload extends NodePayloadBase {
  delta: string;
}

export interface LlmCompletedPayload extends NodePayloadBase {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ToolCalledPayload extends NodePayloadBase {
  server: string;
  tool: string;
  args: unknown;
}

export interface ToolResultPayload extends NodePayloadBase {
  server: string;
  tool: string;
  ok: boolean;
  result: unknown;
}

export interface HumanWaitingPayload extends NodePayloadBase {
  prompt: string;
  timeoutSeconds?: number;
}

export interface HumanInputReceivedPayload extends NodePayloadBase {
  approved: boolean;
  input?: unknown;
}

export interface CheckpointSavedPayload {
  /** 已持久化到的事件序号，恢复时从 seq+1 继续消费 */
  seq: number;
}

/** 事件信封（Event Store 落库行 / SSE 推送帧 共用结构） */
export interface WorkflowEvent<P = unknown> {
  /** 全局自增（SQLite rowid），仅落库后存在 */
  id?: number;
  runId: string;
  /** 运行内单调递增序号 */
  seq: number;
  type: WorkflowEventType;
  payload: P;
  timestamp: string;
}
