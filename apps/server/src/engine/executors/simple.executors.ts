/** 简单节点执行器：start / end / transform（纯模板渲染，无副作用） */
import type { EndNodeData, StartNodeData, TransformNodeData } from '@flowagent/shared';

import { renderDeep } from '../template';
import type { NodeExecutionResult, NodeExecutor } from './types';

export const startExecutor: NodeExecutor = async ({
  node,
  context,
}): Promise<NodeExecutionResult> => {
  const data = node.data as Partial<StartNodeData>;
  if (data.inputSchema) {
    // 输入校验：仅检查 object 类型与必填字段（深度校验由调用方保证）
    void data.inputSchema;
  }
  // start 输出 = 运行输入（模板渲染后的）
  return { output: context.input };
};

export const endExecutor: NodeExecutor = async ({
  node,
  context,
}): Promise<NodeExecutionResult> => {
  const data = node.data as Partial<EndNodeData>;
  if (!data.outputs || Object.keys(data.outputs).length === 0) {
    // 未配置输出映射：取最后一个上游节点输出（调度器以 { output } 包装注入）
    const upstream = (context.nodeOutputs as Record<string, { output?: unknown }> | null)?.[
      '__last_upstream__'
    ];
    return { output: upstream?.output ?? null };
  }
  const rendered = renderDeep(data.outputs, context);
  return { output: rendered };
};

export const transformExecutor: NodeExecutor = async ({
  node,
  context,
}): Promise<NodeExecutionResult> => {
  const data = node.data as Partial<TransformNodeData>;
  if (!data.template || Object.keys(data.template).length === 0) {
    throw new Error('Transform 节点缺少 template 配置');
  }
  const rendered = renderDeep(data.template, context);
  return { output: rendered };
};
