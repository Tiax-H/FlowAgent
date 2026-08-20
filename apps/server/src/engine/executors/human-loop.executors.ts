/** Human 与 Loop 节点执行器 */
import type { HumanNodeData, LoopNodeData, WorkflowEdge, WorkflowNode } from '@flowagent/shared';

import { renderDeep } from '../template';
import type { NodeExecutionResult, NodeExecutor, NodeRuntimeServices } from './types';

export function createHumanExecutor(): NodeExecutor {
  return async ({ node, emit }): Promise<NodeExecutionResult> => {
    const data = node.data as Partial<HumanNodeData>;
    await emit('HUMAN_WAITING', {
      nodeId: node.id,
      nodeType: node.type,
      prompt: data.prompt ?? '',
      timeoutSeconds: data.timeoutSeconds,
    });
    // 挂起：恢复路径（审批/超时）在第 8 周实现，当前运行停在 waiting_human
    return { output: null, suspended: true };
  };
}

export function createLoopExecutor(services: NodeRuntimeServices): NodeExecutor {
  return async ({ node, context, emit }): Promise<NodeExecutionResult> => {
    const data = node.data as Partial<LoopNodeData>;
    if (!data.subgraph || data.subgraph.nodes.length === 0) {
      throw new Error('Loop 节点缺少 subgraph 配置');
    }
    if (typeof data.maxIterations !== 'number' || data.maxIterations < 1) {
      throw new Error('Loop 节点 maxIterations 必须 >= 1');
    }

    const collection = renderDeep(data.collection, context);
    const items = Array.isArray(collection) ? collection : [collection];
    const capped = items.slice(0, data.maxIterations);
    const itemVariable = data.itemVariable ?? 'item';

    // 延迟导入避免与调度器循环依赖
    const { runSubgraph } = await import('../scheduler');
    const results: unknown[] = [];

    for (let index = 0; index < capped.length; index += 1) {
      const item = capped[index];
      await emit('NODE_STARTED', {
        nodeId: node.id,
        nodeType: node.type,
        detail: `iteration ${index + 1}/${capped.length}`,
      });

      const iterationContext = {
        ...context,
        nodeOutputs: { ...context.nodeOutputs },
        loop: { item, index },
        // 迭代变量同时暴露为节点输出命名空间（模板 {{item}} 与 {{loop.item}} 均可）
      };
      (iterationContext.nodeOutputs as Record<string, unknown>)[itemVariable] = item;

      const iterationOutput = await runSubgraph(
        data.subgraph.nodes,
        data.subgraph.edges as WorkflowEdge[],
        iterationContext,
        services,
        emit,
      );
      results.push(iterationOutput);
    }

    return { output: { iterations: capped.length, results } };
  };
}

/** 导出类型辅助（WorkflowNode 供子图节点类型） */
export type { WorkflowNode };
