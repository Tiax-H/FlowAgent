import type { WorkflowEventType } from '@flowagent/shared';

/** 事件类型的中文展示名（时间轴用），未收录的类型原样显示 */
export const EVENT_LABELS: Record<WorkflowEventType, string> = {
  RUN_STARTED: '运行开始',
  RUN_COMPLETED: '运行完成',
  RUN_FAILED: '运行失败',
  RUN_SUSPENDED: '运行挂起',
  RUN_RESUMED: '恢复执行',
  RUN_CANCELED: '取消',
  NODE_STARTED: '节点开始',
  NODE_SUCCEEDED: '节点成功',
  NODE_FAILED: '节点失败',
  NODE_SKIPPED: '节点跳过',
  NODE_RETRYING: '重试中',
  LLM_REQUESTED: '调用模型',
  LLM_TOKEN: '模型输出',
  LLM_COMPLETED: '模型返回',
  TOOL_CALLED: '调用工具',
  TOOL_RESULT: '工具返回',
  HUMAN_WAITING: '等待人工输入',
  HUMAN_INPUT_RECEIVED: '收到人工输入',
  CHECKPOINT_SAVED: '保存检查点',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type as WorkflowEventType] ?? type;
}
