/** 工作流 JSON 导入/导出的纯逻辑（解析、校验、文件名净化），供编辑器 UI 调用 */
import { validateWorkflowDefinition, type WorkflowDefinition } from '@flowagent/shared';

export interface ImportedWorkflow {
  name: string;
  definition: WorkflowDefinition;
}

export type ImportResult =
  | { ok: true; value: ImportedWorkflow }
  | { ok: false; error: string };

/** 解析导入的 JSON 文本；非法 JSON 或定义校验失败时返回可展示的错误 */
export function parseImportedWorkflow(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' };
  }
  const result = validateWorkflowDefinition(parsed);
  if (!result.valid) {
    return { ok: false, error: `工作流定义校验失败：${result.errors.slice(0, 3).join('；')}` };
  }
  const definition = parsed as WorkflowDefinition;
  return {
    ok: true,
    value: { name: definition.name?.trim() || '导入的工作流', definition },
  };
}

/** 导出文件名：替换文件系统非法字符，空名称回退 workflow */
export function exportFileName(name: string): string {
  const sanitized = name.trim().replace(/[\\/:*?"<>|]/g, '_');
  return `${sanitized || 'workflow'}.json`;
}
