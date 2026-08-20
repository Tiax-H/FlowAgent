/**
 * Agent 节点执行器：OpenAI function calling 标准 ReAct 循环。
 *
 * 每轮：LLM → tool_calls？→ 并发执行工具 → 结果回填 → 下一轮；
 * 无 tool_calls 或达到 maxIterations 时终止，返回最终输出。
 */
import type { AgentNodeData, McpToolBinding } from '@flowagent/shared';

import { renderDeep } from '../template';
import type { NodeExecutionResult, NodeExecutor, NodeRuntimeServices } from './types';

const MAX_ITERATIONS_HARD_CAP = 32;

export function createAgentExecutor(services: NodeRuntimeServices): NodeExecutor {
  return async ({ node, context, emit }): Promise<NodeExecutionResult> => {
    const data = node.data as Partial<AgentNodeData>;
    if (!data.provider || !data.model) throw new Error('Agent 节点缺少 provider/model 配置');

    const maxIterations = Math.min(Math.max(data.maxIterations ?? 8, 1), MAX_ITERATIONS_HARD_CAP);
    const bindings: McpToolBinding[] = data.tools ?? [];
    const toolSchemas = await services.listToolSchemas(bindings);

    // 工具名映射：MCP 全限定名 <-> LLM 函数名（函数名不允许冒号）
    const functionToBinding = new Map<string, McpToolBinding>();
    const tools = toolSchemas.map((schema) => {
      const functionName = `${schema.server}__${schema.tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      functionToBinding.set(functionName, { server: schema.server, tool: schema.tool });
      return {
        type: 'function' as const,
        function: {
          name: functionName,
          description: schema.description ?? `${schema.server}:${schema.tool}`,
          parameters: (schema.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
        },
      };
    });

    const messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
    }> = [];
    if (data.systemPrompt) {
      messages.push({ role: 'system', content: data.systemPrompt });
    }
    const prompt = renderDeep(data.prompt ?? '', context);
    messages.push({ role: 'user', content: String(prompt) });

    await emit('LLM_REQUESTED', {
      nodeId: node.id,
      nodeType: node.type,
      provider: data.provider,
      model: data.model,
    });

    let finalContent: string | null = null;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const result = await services.llm.chatCompletion(data.provider, data.model, {
        messages: [...messages],
        tools: tools.length > 0 ? tools : undefined,
        temperature: data.temperature,
      });

      // 无工具调用：终轮
      if (!result.toolCalls || result.toolCalls.length === 0) {
        finalContent = result.content;
        await emit('LLM_COMPLETED', {
          nodeId: node.id,
          nodeType: node.type,
          content: result.content ?? '',
          usage: result.usage,
        });
        break;
      }

      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: call.function,
        })),
      });

      // 并发执行所有工具调用
      const toolResults = await Promise.all(
        result.toolCalls.map(async (call) => {
          const binding = functionToBinding.get(call.function.name);
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            args = {};
          }

          if (!binding) {
            return {
              call,
              ok: false as const,
              result: { error: `未知工具: ${call.function.name}` },
            };
          }

          await emit('TOOL_CALLED', {
            nodeId: node.id,
            nodeType: node.type,
            server: binding.server,
            tool: binding.tool,
            args,
          });

          const outcome = await services
            .callTool(binding.server, binding.tool, args)
            .catch((error: unknown) => ({
              ok: false as const,
              result: { error: error instanceof Error ? error.message : String(error) },
            }));

          await emit('TOOL_RESULT', {
            nodeId: node.id,
            nodeType: node.type,
            server: binding.server,
            tool: binding.tool,
            ok: outcome.ok,
            result: outcome.result,
          });

          return { call, ...outcome };
        }),
      );

      for (const toolResult of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: toolResult.call.id,
          content: JSON.stringify(toolResult.result).slice(0, 20_000),
        });
      }
    }

    if (finalContent === null) {
      finalContent = `Agent 达到最大轮数（${maxIterations}）未产生最终回复`;
      await emit('LLM_COMPLETED', {
        nodeId: node.id,
        nodeType: node.type,
        content: finalContent,
      });
    }

    let parsed: unknown = finalContent;
    if (typeof finalContent === 'string') {
      try {
        parsed = JSON.parse(finalContent) as unknown;
      } catch {
        parsed = { text: finalContent };
      }
    }
    return { output: parsed };
  };
}
