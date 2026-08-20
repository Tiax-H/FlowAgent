/**
 * 拓扑调度器：事件驱动的 DAG 执行引擎。
 *
 * 红线：
 * - 主图必须是严格 DAG（启动前用 shared 校验复检）
 * - 持久状态只能来自事件投影；内存 nodeOutputs 仅为本次调度的工作集
 *
 * 语义：
 * - 就绪节点并发执行（并行语义）
 * - Condition 求值选分支，未选分支下游跳过（剪枝）
 * - 节点失败 → RUN_FAILED，停止调度新节点
 * - Human 挂起 → RUN_SUSPENDED，停止调度（恢复路径第 8 周）
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  ConditionNodeData,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEventType,
  WorkflowNode,
} from '@flowagent/shared';
import { validateWorkflowDefinition } from '@flowagent/shared';

import { LlmAdapter } from '../llm/llm.adapter';
import { McpRegistryService } from '../mcp/mcp.registry';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from '../runs/runs.service';
import { EventStore } from './event-store.service';
import { evaluateCondition } from './expression';
import { createAgentExecutor } from './executors/agent.executor';
import { createHumanExecutor, createLoopExecutor } from './executors/human-loop.executors';
import { createLlmExecutor, createToolExecutor } from './executors/llm-tool.executors';
import { endExecutor, startExecutor, transformExecutor } from './executors/simple.executors';
import type { NodeRuntimeServices } from './executors/types';
import { type TemplateContext } from './template';

type EmitFn = (type: WorkflowEventType, payload: Record<string, unknown>) => Promise<void>;

function createExecutorFactory(services: NodeRuntimeServices) {
  const agent = createAgentExecutor(services);
  return (type: WorkflowNode['type']) => {
    switch (type) {
      case 'start':
        return startExecutor;
      case 'end':
        return endExecutor;
      case 'transform':
        return transformExecutor;
      case 'llm':
        return createLlmExecutor(services);
      case 'tool':
        return createToolExecutor(services);
      case 'agent':
        return agent;
      case 'condition':
        return conditionExecutor;
      case 'human':
        return createHumanExecutor();
      case 'loop':
        return createLoopExecutor(services);
      default:
        throw new Error(`未知节点类型: ${String(type)}`);
    }
  };
}

/** Condition 执行器：求值选分支，输出 selected 供调度器剪枝 */
const conditionExecutor = async ({ node, context }: {
  node: WorkflowNode;
  context: TemplateContext;
  nextSeq: () => number;
  emit: EmitFn;
}): Promise<{ output: unknown; suspended?: boolean }> => {
  const data = node.data as Partial<ConditionNodeData>;
  const branches = data.branches ?? [];
  if (branches.length === 0) throw new Error('Condition 节点缺少分支配置');

  for (const branch of branches) {
    if (evaluateCondition(branch.expression, context)) {
      return { output: { selected: branch.id } };
    }
  }
  throw new Error(`Condition 节点 "${node.id}" 所有分支均不满足`);
};

function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (indegree.has(edge.source) && indegree.has(edge.target)) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
  }
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const ordered: WorkflowNode[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = nodeById.get(current);
    if (node) ordered.push(node);
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return ordered;
}

/** 子图迭代执行（Loop 执行器调用）：按拓扑序线性执行子图节点 */
export async function runSubgraph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  context: TemplateContext,
  services: NodeRuntimeServices,
  emit: EmitFn,
): Promise<unknown> {
  const executorFactory = createExecutorFactory(services);
  const order = topoSort(nodes, edges);
  const outputs: Record<string, unknown> = { ...context.nodeOutputs };
  let lastOutput: unknown = null;

  for (const node of order) {
    const executor = executorFactory(node.type);
    const result = await executor({
      node,
      context: { ...context, nodeOutputs: outputs },
      nextSeq: () => 0,
      emit,
    });
    outputs[node.id] = { output: result.output };
    lastOutput = result.output;
  }
  return lastOutput;
}

@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventStore: EventStore,
    private readonly llmAdapter: LlmAdapter,
    private readonly mcpRegistry: McpRegistryService,
    private readonly runsService: RunsService,
  ) {}

  async execute(runId: string, workflowId: string, input: unknown): Promise<void> {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    try {
      await this.doExecute(runId, workflowId, input);
    } catch (error) {
      this.logger.error(`run ${runId} 调度器异常: ${String(error)}`);
      await this.terminate(runId, 'RUN_FAILED', {
        error: `调度器异常: ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => undefined);
    } finally {
      this.running.delete(runId);
    }
  }

  private async doExecute(runId: string, workflowId: string, input: unknown): Promise<void> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) {
      await this.terminate(runId, 'RUN_FAILED', { error: `工作流不存在: ${workflowId}` });
      return;
    }
    let definition: WorkflowDefinition;
    try {
      definition = JSON.parse(workflow.definition) as WorkflowDefinition;
    } catch {
      await this.terminate(runId, 'RUN_FAILED', { error: '工作流定义解析失败' });
      return;
    }

    const validation = validateWorkflowDefinition(definition);
    if (!validation.valid) {
      await this.terminate(runId, 'RUN_FAILED', { error: `定义校验失败: ${validation.errors.join('; ')}` });
      return;
    }

    let seq = await this.eventStore.nextSeq(runId);
    const emit: EmitFn = async (type, payload) => {
      await this.eventStore.append(runId, seq, type, payload);
      seq += 1;
    };

    const services: NodeRuntimeServices = {
      llm: {
        chatCompletion: (provider, model, request) =>
          this.llmAdapter.chatCompletion(provider, model, request),
      },
      callTool: (server, tool, args) => this.mcpRegistry.callTool(server, tool, args),
      listToolSchemas: async (bindings) => {
        const results = await Promise.all(
          bindings.map(async (binding) => {
            const tools = await this.prisma.mcpTool.findMany({
              where: { server: { name: binding.server }, name: binding.tool },
              include: { server: { select: { name: true } } },
            });
            return tools.map((tool) => ({
              server: tool.server.name,
              tool: tool.name,
              description: tool.description,
              inputSchema: JSON.parse(tool.inputSchema) as unknown,
            }));
          }),
        );
        return results.flat();
      },
    };
    const executorFactory = createExecutorFactory(services);

    const nodes = definition.nodes;
    const edges = definition.edges;
    const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      indegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }

    const nodeOutputs: Record<string, unknown> = {};
    const variables: Record<string, unknown> = {};
    for (const variable of definition.variables ?? []) {
      variables[variable.name] = variable.default ?? null;
    }

    // 终止标志：任一节点失败或挂起即停止调度新节点
    let aborted = false;
    let suspended = false;

    const ready: string[] = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
    let cursor = 0;
    const inflight = new Set<Promise<void>>();

    const onNodeSettled = (nodeId: string): void => {
      for (const target of adjacency.get(nodeId) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0 && !aborted && !suspended) ready.push(target);
      }
    };

    const executeNode = async (nodeId: string): Promise<void> => {
      const node = nodeById.get(nodeId);
      if (!node) return;

      await emit('NODE_STARTED', { nodeId, nodeType: node.type });
      const context: TemplateContext = { input, variables, nodeOutputs };

      try {
        const result = await executorFactory(node.type)({ node, context, nextSeq: () => seq, emit });

        if (result.suspended) {
          suspended = true;
          await emit('RUN_SUSPENDED', { nodeId, reason: 'human' });
          return;
        }

        nodeOutputs[nodeId] = { output: result.output };
        nodeOutputs['__last_upstream__'] = { output: result.output };
        await emit('NODE_SUCCEEDED', { nodeId, nodeType: node.type, output: result.output });

        if (node.type === 'condition') {
          const selected = (result.output as { selected?: string } | null)?.selected;
          if (typeof selected !== 'string') throw new Error('Condition 输出缺少 selected 分支');
          // 剪枝：仅 selected 分支的出边生效，其余分支下游发 SKIPPED
          for (const edge of edges.filter((item) => item.source === nodeId)) {
            if (edge.sourceHandle === selected) {
              const remaining = (indegree.get(edge.target) ?? 0) - 1;
              indegree.set(edge.target, remaining);
              if (remaining === 0) ready.push(edge.target);
            } else {
              await emit('NODE_SKIPPED', { nodeId: edge.target, nodeType: nodeById.get(edge.target)?.type ?? '' });
              skipDownstream(edge.target);
            }
          }
          return;
        }

        onNodeSettled(nodeId);
      } catch (error) {
        aborted = true;
        const message = error instanceof Error ? error.message : String(error);
        await emit('NODE_FAILED', { nodeId, nodeType: node.type, error: message });
        await this.terminate(runId, 'RUN_FAILED', { error: `节点 ${nodeId} 失败: ${message}` });
      }
    };

    const skipDownstream = (nodeId: string): void => {
      for (const target of adjacency.get(nodeId) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) skipDownstream(target);
      }
    };

    // 主循环：并发执行就绪节点
    while (cursor < ready.length || inflight.size > 0) {
      while (cursor < ready.length && !aborted && !suspended) {
        const nodeId = ready[cursor];
        cursor += 1;
        if (nodeId === undefined) continue;
        const task = executeNode(nodeId).finally(() => {
          inflight.delete(task);
        });
        inflight.add(task);
      }
      if (inflight.size > 0) {
        await Promise.race(inflight);
      } else {
        break;
      }
    }

    await Promise.allSettled(inflight);

    if (aborted) return; // RUN_FAILED 已发
    if (suspended) {
      await this.runsService.syncFromProjection(runId);
      return;
    }

    const endNode = nodes.find((node) => node.type === 'end');
    const endOutput = endNode ? nodeOutputs[endNode.id] : undefined;
    const output = endOutput && typeof endOutput === 'object' && 'output' in endOutput ? endOutput.output : null;
    await this.terminate(runId, 'RUN_COMPLETED', { output });
  }

  private async terminate(
    runId: string,
    type: 'RUN_COMPLETED' | 'RUN_FAILED',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const seq = await this.eventStore.nextSeq(runId);
    await this.eventStore.append(runId, seq, type, payload);
    await this.runsService.syncFromProjection(runId);
  }
}
