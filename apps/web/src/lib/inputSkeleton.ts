import type { WorkflowDefinition } from '@flowagent/shared';

const INPUT_REF = /\{\{\s*input\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*\}\}/g;

/** 递归收集节点 data 中所有 {{input.xxx}} 引用的顶层字段名（去重） */
export function collectInputFieldNames(definition: WorkflowDefinition): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(INPUT_REF)) {
        const path = match[1];
        const top = path?.split('.')[0];
        if (top) names.add(top);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  for (const node of definition.nodes) visit(node.data);
  return [...names].sort();
}

/** 按引用字段生成输入骨架：{"diff": ""}，供运行对话框预填 */
export function buildInputSkeleton(definition: WorkflowDefinition): Record<string, string> {
  return Object.fromEntries(collectInputFieldNames(definition).map((name) => [name, '']));
}
