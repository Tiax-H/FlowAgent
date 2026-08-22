import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { NodeType, WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types';

let idCounter = 0;

/** 生成画布内唯一 id（本地新建节点用；加载的工作流沿用已有 id） */
export function nextNodeId(type: NodeType): string {
  idCounter += 1;
  return `${type}_${Date.now().toString(36)}_${idCounter}`;
}

export function createFlowNode(
  type: NodeType,
  position: XYPosition,
  data: Record<string, unknown> = {},
): Node {
  return {
    id: nextNodeId(type),
    type: 'flowagent',
    position,
    data: { nodeType: type, name: NODE_DEFAULT_NAMES[type], ...data },
  };
}

export const NODE_DEFAULT_NAMES: Record<NodeType, string> = {
  start: '开始',
  end: '结束',
  agent: 'Agent',
  llm: 'LLM',
  tool: '工具',
  condition: '条件分支',
  loop: '循环',
  human: '人工审批',
  transform: '数据映射',
};

/**
 * WorkflowDefinition（契约）→ React Flow 节点/边。
 * 节点级顶层字段（timeoutMs/retry）暂存进 data.__nodeExtras，
 * 画布暂无编辑入口但不丢失：保存/导出时还原（见 flowToDefinition）。
 */
export function definitionToFlow(definition: WorkflowDefinition): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = definition.nodes.map((node: WorkflowNode) => {
    const extras: Record<string, unknown> = {};
    if (node.timeoutMs !== undefined) extras.timeoutMs = node.timeoutMs;
    if (node.retry !== undefined) extras.retry = node.retry;
    return {
      id: node.id,
      type: 'flowagent',
      position: { x: node.position.x, y: node.position.y },
      data: {
        nodeType: node.type,
        name: node.name,
        ...(Object.keys(extras).length > 0 ? { __nodeExtras: extras } : {}),
        ...node.data,
      },
    };
  });
  const edges: Edge[] = definition.edges.map((edge: WorkflowEdge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
  }));
  return { nodes, edges };
}

/** React Flow 节点/边 → WorkflowDefinition（契约）；__nodeExtras 还原为节点顶层字段 */
export function flowToDefinition(
  nodes: Node[],
  edges: Edge[],
  base: WorkflowDefinition,
): WorkflowDefinition {
  return {
    ...base,
    nodes: nodes.map((node) => {
      const {
        nodeType,
        name,
        __nodeExtras,
        ...rest
      } = node.data as {
        nodeType: NodeType;
        name: string;
        __nodeExtras?: { timeoutMs?: number; retry?: WorkflowNode['retry'] };
      } & Record<string, unknown>;
      const workflowNode: WorkflowNode = {
        id: node.id,
        type: nodeType,
        name,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        data: rest,
      };
      if (__nodeExtras?.timeoutMs !== undefined) workflowNode.timeoutMs = __nodeExtras.timeoutMs;
      if (__nodeExtras?.retry !== undefined) workflowNode.retry = __nodeExtras.retry;
      return workflowNode;
    }),
    edges: edges.map((edge) => {
      const workflowEdge: WorkflowEdge = { id: edge.id, source: edge.source, target: edge.target };
      if (edge.sourceHandle) workflowEdge.sourceHandle = edge.sourceHandle;
      return workflowEdge;
    }),
  };
}
