/**
 * Agent 节点执行器：OpenAI function calling 标准 ReAct 循环。
 *
 * 每轮：LLM → tool_calls？→ 并发执行工具 → 结果回填 → 下一轮；
 * 无 tool_calls 或达到 maxIterations 时终止，返回最终输出。
 */
import type { AgentNodeData, McpToolBinding } from '@flowagent/shared';

import { truncateForEvent } from '../payload';
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

    // 工具名映射：MCP 全限定名 <-> LLM 函数名（函数名不允许冒号）。
    // 净化可能碰撞（server "a:b"+tool "c" 与 server "a_b"+tool "c" 同名）：碰撞即报错，绝不静默错路由
    const functionToBinding = new Map<string, McpToolBinding>();
    const tools = toolSchemas.map((schema) => {
      const functionName = `${schema.server}__${schema.tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const binding: McpToolBinding = { server: schema.server, tool: schema.tool };
      const existing = functionToBinding.get(functionName);
      if (
        existing &&
        (existing.server !== binding.server || existing.tool !== binding.tool)
      ) {
        throw new Error(
          `工具函数名碰撞: "${functionName}" 同时映射 ${existing.server}:${existing.tool} 与 ${schema.server}:${schema.tool}，请重命名 MCP Server`,
        );
      }
      functionToBinding.set(functionName, binding);
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
        // 节点超时透传给 Adapter：超时真正中止底层请求，而不是留下僵尸调用
        timeoutMs:
          typeof node.timeoutMs === 'number' && node.timeoutMs > 0 ? node.timeoutMs : undefined,
      });

      // 无工具调用：终轮
      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (!result.content || result.content.trim() === '') {
          // 空回复不可能是有效的最终答案：与其让节点带着占位文本「成功」并污染下游，
          // 不如显式失败，把排查方向（Base URL 非开放AI兼容端点 / 模型名错误）直接给用户
          throw new Error(
            '模型返回了空回复（无 content 且无工具调用）。常见原因：Provider 的 Base URL 不是 OpenAI 兼容端点（例如误用了 Anthropic 兼容地址），或模型名不正确',
          );
        }
        finalContent = result.content;
        await emit('LLM_COMPLETED', {
          nodeId: node.id,
          nodeType: node.type,
          content: truncateForEvent(result.content ?? ''),
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
            result: truncateForEvent(outcome.result),
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
