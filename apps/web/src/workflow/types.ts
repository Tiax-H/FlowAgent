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

/** 后端 /api/workflows 返回结构 */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition | null;
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

export const NODE_TYPE_META: Record<NodeType, { label: string; color: string; hint: string }> = {
  start: { label: 'Start', color: 'bg-emerald-100 text-emerald-700 border-emerald-300', hint: '输入边界' },
  end: { label: 'End', color: 'bg-rose-100 text-rose-700 border-rose-300', hint: '输出边界' },
  agent: {
    label: 'Agent',
    color: 'bg-violet-100 text-violet-700 border-violet-300',
    hint: 'LLM + ReAct + MCP 工具 + 独立模型',
  },
  llm: { label: 'LLM', color: 'bg-blue-100 text-blue-700 border-blue-300', hint: '纯文本变换，无工具' },
  tool: { label: 'Tool', color: 'bg-amber-100 text-amber-700 border-amber-300', hint: '直调单个 MCP 工具' },
  condition: {
    label: 'Condition',
    color: 'bg-orange-100 text-orange-700 border-orange-300',
    hint: '表达式条件分支',
  },
  loop: { label: 'Loop', color: 'bg-teal-100 text-teal-700 border-teal-300', hint: '子图迭代（环语义收敛于此）' },
  human: { label: 'Human', color: 'bg-pink-100 text-pink-700 border-pink-300', hint: '挂起等待审批/输入' },
  transform: {
    label: 'Transform',
    color: 'bg-neutral-100 text-neutral-700 border-neutral-300',
    hint: '模板数据映射 {{node.output}}',
  },
};
