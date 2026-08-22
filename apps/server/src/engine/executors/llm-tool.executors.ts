/** LLM / Tool 节点执行器 */
import type { LlmNodeData, ToolNodeData } from '@flowagent/shared';

import { truncateForEvent } from '../payload';
import { renderDeep } from '../template';
import type { NodeExecutionResult, NodeExecutor, NodeRuntimeServices } from './types';

export function createLlmExecutor(services: NodeRuntimeServices): NodeExecutor {
  return async ({ node, context, emit }): Promise<NodeExecutionResult> => {
    const data = node.data as Partial<LlmNodeData>;
    if (!data.provider || !data.model) throw new Error('LLM 节点缺少 provider/model 配置');
    const prompt = typeof data.prompt === 'string' ? data.prompt : '';
    if (prompt.trim().length === 0) throw new Error('LLM 节点缺少 prompt');

    const renderedPrompt = renderDeep(prompt, context);
    await emit('LLM_REQUESTED', {
      nodeId: node.id,
      nodeType: node.type,
      provider: data.provider,
      model: data.model,
    });

    const result = await services.llm.chatCompletion(data.provider, data.model, {
      messages: [{ role: 'user', content: String(renderedPrompt) }],
      temperature: data.temperature,
      // 节点超时透传给 Adapter：超时真正中止底层请求，而不是留下僵尸调用
      timeoutMs:
        typeof node.timeoutMs === 'number' && node.timeoutMs > 0 ? node.timeoutMs : undefined,
    });

    await emit('LLM_COMPLETED', {
      nodeId: node.id,
      nodeType: node.type,
      content: truncateForEvent(result.content ?? ''),
      usage: result.usage,
    });

    let parsed: unknown = result.content;
    if (typeof result.content === 'string') {
      try {
        parsed = JSON.parse(result.content) as unknown;
      } catch {
        parsed = { text: result.content };
      }
    }
    return { output: parsed };
  };
}

export function createToolExecutor(services: NodeRuntimeServices): NodeExecutor {
  return async ({ node, context, emit }): Promise<NodeExecutionResult> => {
    const data = node.data as Partial<ToolNodeData>;
    if (!data.server || !data.tool) throw new Error('Tool 节点缺少 server/tool 配置');

    const args = renderDeep(data.args ?? {}, context) as Record<string, unknown>;
    await emit('TOOL_CALLED', {
      nodeId: node.id,
      nodeType: node.type,
      server: data.server,
      tool: data.tool,
      args,
    });

    const result = await services.callTool(data.server, data.tool, args);
    await emit('TOOL_RESULT', {
      nodeId: node.id,
      nodeType: node.type,
      server: data.server,
      tool: data.tool,
      ok: result.ok,
      result: truncateForEvent(result.result),
    });

    if (!result.ok) {
      throw new Error(`工具调用失败 ${data.server}:${data.tool}`);
    }

    let parsed: unknown = result.result;
    if (Array.isArray(result.result)) {
      const text = result.result
        .filter((item): item is { type: string; text: string } => {
          const candidate = item as { type?: string; text?: unknown };
          return candidate.type === 'text' && typeof candidate.text === 'string';
        })
        .map((item) => item.text)
        .join('\n');
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = { text };
        }
      }
    }
    return { output: parsed };
  };
}
