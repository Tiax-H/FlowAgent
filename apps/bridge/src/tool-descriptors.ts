/** 工作流 → MCP 工具描述符映射（纯函数，无副作用）。 */
import type { WorkflowListItem } from './flowagent-client.js';

/** MCP 工具名兼容字符集（Claude Code 等严格客户端）：字母数字下划线连字符，≤64 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function workflowToolName(workflowId: string): string {
  return `flowagent_run_${workflowId}`;
}

export function isEligibleWorkflowToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

export interface WorkflowToolDescriptor {
  name: string;
  title: string;
  description: string;
}

export function describeWorkflowTool(workflow: WorkflowListItem): WorkflowToolDescriptor {
  const lines: string[] = [`运行 FlowAgent 工作流「${workflow.name}」(v${workflow.version})。`];
  if (workflow.description) lines.push(workflow.description);
  lines.push('入参 input 为 Start 节点输入；返回 { runId, status, output?, error? }。');
  lines.push('waitMs=0 时立即返回持久句柄 runId，之后用 flowagent_get_run 轮询结果。');
  return {
    name: workflowToolName(workflow.id),
    title: workflow.name,
    description: lines.join('\n'),
  };
}

export function diffToolNames(
  current: string[],
  next: string[],
): { toAdd: string[]; toRemove: string[] } {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    toAdd: next.filter((name) => !currentSet.has(name)),
    toRemove: current.filter((name) => !nextSet.has(name)),
  };
}
