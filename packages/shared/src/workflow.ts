/**
 * 工作流定义类型（唯一事实源）。
 *
 * 前后端只从这里 import 类型；运行时校验见 `validateWorkflowDefinition`。
 */

/** 当前工作流定义的结构版本，随 schema 演进递增 */
export const SCHEMA_VERSION = 1;

/** 支持的节点类型（刻意不膨胀，见 docs/PROJECT_PLAN.md §4） */
export const NODE_TYPE_VALUES = [
  'start',
  'end',
  'agent',
  'llm',
  'tool',
  'condition',
  'loop',
  'human',
  'transform',
] as const;

export type NodeType = (typeof NODE_TYPE_VALUES)[number];

/** MCP 工具绑定：定位某个 MCP Server 暴露的工具 */
export interface McpToolBinding {
  /** MCP Gateway 中注册的 Server 连接名 */
  server: string;
  /** Server 内的工具名 */
  tool: string;
}

export interface StartNodeData {
  /** 触发输入的 JSON Schema（可选，用于运行时输入校验） */
  inputSchema?: Record<string, unknown>;
}

export interface EndNodeData {
  /** 最终输出字段的模板映射，值支持 `{{node_x.output}}` 语法 */
  outputs?: Record<string, string>;
}

export interface AgentNodeData {
  /** Provider 名称（Provider 配置表中的 key） */
  provider: string;
  /** 该 Provider 下的模型名 */
  model: string;
  systemPrompt?: string;
  /** 用户提示词，支持 `{{node_x.output}}` / `{{variables.y}}` 模板 */
  prompt?: string;
  /** 绑定的 MCP 工具列表，为空则纯文本对话 */
  tools?: McpToolBinding[];
  /** ReAct 循环最大轮数，防止失控 */
  maxIterations?: number;
  temperature?: number;
  memory?: {
    enabled: boolean;
    /** 记忆窗口内最大消息数 */
    maxMessages?: number;
  };
}

export interface LlmNodeData {
  provider: string;
  model: string;
  /** 支持模板语法的提示词 */
  prompt: string;
  temperature?: number;
}

export interface ToolNodeData {
  server: string;
  tool: string;
  /** 直调参数，值支持模板语法 */
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ConditionBranch {
  /** 分支标识，对应出边的 sourceHandle */
  id: string;
  label?: string;
  /** JS 表达式（安全沙箱内求值），字面量 `true` 表示默认分支 */
  expression: string;
}

export interface ConditionNodeData {
  branches: ConditionBranch[];
}

export interface LoopNodeData {
  /** 最大迭代次数（硬上限） */
  maxIterations: number;
  /** 迭代变量名，循环体内通过 `{{loop.item}}` 引用 */
  itemVariable?: string;
  /** 待迭代集合的模板表达式 */
  collection: string;
}

export interface HumanNodeData {
  /** 展示给审批人的说明 */
  prompt: string;
  /** 挂起超时（秒），超时按失败处理；缺省为无限等待 */
  timeoutSeconds?: number;
  /** 指定审批人（预留） */
  assignee?: string;
}

export interface TransformNodeData {
  /** 输出字段的模板映射，如 `{ summary: "{{agent_1.output}}" }` */
  template: Record<string, string>;
}

export interface WorkflowNodeBase {
  /** 画布内唯一节点 id */
  id: string;
  type: NodeType;
  name: string;
  /** 画布坐标（仅前端使用，引擎不读） */
  position: { x: number; y: number };
}

/** 画布节点：`data` 按类型收窄为上述各 NodeData 接口 */
export interface WorkflowNode extends WorkflowNodeBase {
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Condition 节点出边必填，对应分支 id */
  sourceHandle?: string;
}

export const VARIABLE_TYPE_VALUES = ['string', 'number', 'boolean', 'json'] as const;
export type VariableType = (typeof VARIABLE_TYPE_VALUES)[number];

export interface WorkflowVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  default?: unknown;
}

/** 工作流定义（保存 / 加载 / 执行的完整契约） */
export interface WorkflowDefinition {
  schemaVersion: typeof SCHEMA_VERSION;
  name?: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables?: WorkflowVariable[];
}
