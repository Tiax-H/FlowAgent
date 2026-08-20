/**
 * 节点执行器接口与执行上下文。
 *
 * 执行器只做单节点的副作用（LLM 调用/工具调用/模板渲染/挂起），
 * 状态变更一律通过 emit 事件（红线：状态只能来自事件投影）。
 */
import type { NodeType, WorkflowEventType, WorkflowNode } from '@flowagent/shared';

import type { TemplateContext } from '../template';

export interface NodeExecutionInput {
  node: WorkflowNode;
  context: TemplateContext;
  /** 已有事件序号计数器的引用，emit 前自增 */
  nextSeq: () => number;
  emit: (type: WorkflowEventType, payload: Record<string, unknown>) => Promise<void>;
}

export interface NodeExecutionResult {
  output: unknown;
  /** 挂起等待：Human 节点返回 */
  suspended?: boolean;
}

export type NodeExecutor = (input: NodeExecutionInput) => Promise<NodeExecutionResult>;

export interface NodeExecutorRegistry {
  resolve(type: NodeType): NodeExecutor;
}

export interface NodeRuntimeServices {
  /** LLM 调用（agent/llm 节点） */
  llm: {
    chatCompletion: (
      provider: string,
      model: string,
      request: {
        messages: Array<{
          role: 'system' | 'user' | 'assistant' | 'tool';
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
          tool_call_id?: string;
        }>;
        tools?: Array<{
          type: 'function';
          function: { name: string; description?: string; parameters: Record<string, unknown> };
        }>;
        temperature?: number;
        timeoutMs?: number;
      },
  ) => Promise<{
    content: string | null;
    toolCalls?: Array<{ id: string; type?: 'function'; function: { name: string; arguments: string } }>;
    usage?: { promptTokens?: number; completionTokens?: number };
  }>;
  };
  /** MCP 工具调用（tool/agent 节点），必须走注册表路由 */
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;
  /** MCP 工具 schema 查询（agent 节点绑定工具转换） */
  listToolSchemas: (bindings: Array<{ server: string; tool: string }>) => Promise<
    Array<{
      server: string;
      tool: string;
      description?: string | null;
      inputSchema: unknown;
    }>
  >;
}
