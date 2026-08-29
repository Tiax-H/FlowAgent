import type {
  AgentNodeData,
  ConditionNodeData,
  EndNodeData,
  HumanNodeData,
  LlmNodeData,
  LoopNodeData,
  McpToolBinding,
  NodeType,
  StartNodeData,
  ToolNodeData,
  TransformNodeData,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '@flowagent/shared';

export type {
  AgentNodeData,
  ConditionNodeData,
  EndNodeData,
  HumanNodeData,
  LlmNodeData,
  LoopNodeData,
  McpToolBinding,
  NodeType,
  StartNodeData,
  ToolNodeData,
  TransformNodeData,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
};

/** 后端 /api/workflows 返回结构；列表接口可能不返回 definition（详情接口始终返回） */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  definition?: WorkflowDefinition | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type NodeDataByType = {
  start: StartNodeData;
  end: EndNodeData;
  agent: AgentNodeData;
  llm: LlmNodeData;
  tool: ToolNodeData;
  condition: ConditionNodeData;
  loop: LoopNodeData;
  human: HumanNodeData;
  transform: TransformNodeData;
};

/**
 * 节点类型色板（视觉规范 v1 §6.5）：中性类型用 sand，业务类型用浅底-深字的类型色
 * （Agent=violet、LLM=品牌、Tool=amber、Condition=cyan、Loop=emerald、Human=pink）；chip 一律无边框。
 */
export const NODE_TYPE_META: Record<NodeType, { label: string; color: string; hint: string }> = {
  start: {
    label: 'Start',
    color: 'bg-sand-3 text-sand-11',
    hint: '输入边界',
  },
  end: { label: 'End', color: 'bg-sand-3 text-sand-11', hint: '输出边界' },
  agent: {
    label: 'Agent',
    color: 'bg-violet-50 text-violet-700',
    hint: 'LLM + ReAct + MCP 工具 + 独立模型',
  },
  llm: {
    label: 'LLM',
    color: 'bg-brand-2 text-brand-11',
    hint: '纯文本变换，无工具',
  },
  tool: {
    label: 'Tool',
    color: 'bg-amber-50 text-amber-700',
    hint: '直调单个 MCP 工具',
  },
  condition: {
    label: 'Condition',
    color: 'bg-cyan-50 text-cyan-700',
    hint: '表达式条件分支',
  },
  loop: {
    label: 'Loop',
    color: 'bg-emerald-50 text-emerald-700',
    hint: '子图迭代（环语义收敛于此）',
  },
  human: {
    label: 'Human',
    color: 'bg-pink-50 text-pink-700',
    hint: '挂起等待审批/输入',
  },
  transform: {
    label: 'Transform',
    color: 'bg-sand-3 text-sand-11',
    hint: '模板数据映射 {{node.output}}',
  },
};
