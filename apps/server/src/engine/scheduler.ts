/**
 * 拓扑调度器：投影驱动、可重入的 DAG 执行引擎。
 *
 * 红线：
 * - 主图必须是严格 DAG（启动前用 shared 校验复检）
 * - 持久状态只能来自事件投影；内存记账仅为本次调度的工作集
 * - 控制动作（暂停/恢复/审批/取消/失败重试）一律追加事件，绝不 UPDATE 既有事件
 *
 * 语义：
 * - execute() 每次先回放该 run 的全部事件重建调度记账，再从断点继续（首次运行 = 空投影退化）
 * - 就绪节点并发执行；Condition 求值选分支，未选分支下游跳过（剪枝）
 * - 节点支持单次尝试超时与指数退避重试；Human 挂起不吃超时/重试
 * - 每个节点 settle 后发射 CHECKPOINT_SAVED（seq = 已消费到的最后一条事件序号）
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type {
  ConditionNodeData,
  HumanInputRequest,
  NodeRetryPolicy,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowNode,
} from '@flowagent/shared';
import { validateWorkflowDefinition } from '@flowagent/shared';

import { extractLlmErrorFields, LlmAdapter } from '../llm/llm.adapter';
import { McpRegistryService } from '../mcp/mcp.registry';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from '../runs/runs.service';
import { EventStore } from './event-store.service';
import { evaluateCondition } from './expression';
import { isTerminalRunStatus, projectRunState, type ProjectedRunState } from './projection';
import { createAgentExecutor } from './executors/agent.executor';
import { createHumanExecutor, createLoopExecutor } from './executors/human-loop.executors';
import { createLlmExecutor, createToolExecutor } from './executors/llm-tool.executors';
import { endExecutor, startExecutor, transformExecutor } from './executors/simple.executors';
import type { NodeExecutionResult, NodeRuntimeServices } from './executors/types';
import { truncateForEvent } from './payload';
import { type TemplateContext } from './template';

/** 事件发射器：经 EventStore 的 per-run 串行队列原子分配 seq 并落库，返回实际事件序号 */
type EmitFn = (type: WorkflowEventType, payload: Record<string, unknown>) => Promise<number>;

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
const conditionExecutor = async ({
  node,
  context,
}: {
  node: WorkflowNode;
  context: TemplateContext;
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
      emit,
    });
    outputs[node.id] = { output: result.output };
    lastOutput = result.output;
  }
  return lastOutput;
}

/* ---------------- 韧性策略：超时 + 指数退避重试（纯函数，供单测） ---------------- */

/** 规范化后的重试策略（缺省值已填充） */
export interface ResolvedRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
}

/** 解析节点 retry 配置；缺失/非法返回 null（= 只试一次） */
export function normalizeRetryPolicy(
  retry: NodeRetryPolicy | undefined,
): ResolvedRetryPolicy | null {
  if (!retry || typeof retry.maxAttempts !== 'number' || retry.maxAttempts < 1) return null;
  return {
    maxAttempts: Math.floor(retry.maxAttempts),
    initialDelayMs:
      typeof retry.initialDelayMs === 'number' && retry.initialDelayMs > 0
        ? retry.initialDelayMs
        : 500,
    backoffFactor:
      typeof retry.backoffFactor === 'number' && retry.backoffFactor > 0 ? retry.backoffFactor : 2,
    maxDelayMs:
      typeof retry.maxDelayMs === 'number' && retry.maxDelayMs > 0 ? retry.maxDelayMs : 30_000,
  };
}

/** 第 failedAttempt 次失败后的退避等待（毫秒） */
export function retryDelayMs(policy: ResolvedRetryPolicy, failedAttempt: number): number {
  const raw = policy.initialDelayMs * policy.backoffFactor ** (failedAttempt - 1);
  return Math.min(Math.round(raw), policy.maxDelayMs);
}

/** 超时包装：Promise.race + clearTimeout 防句柄泄漏；timeoutMs 为 null 时透传 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
  message: string,
): Promise<T> {
  if (timeoutMs === null) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------- 恢复记账：由投影重建调度工作集（纯函数，供单测） ---------------- */

/** 可重入调度的工作集：nodeOutputs/入度/邻接/就绪队列/历史 Human 挂起锚点 */
export interface SchedulingWorkset {
  nodeOutputs: Record<string, unknown>;
  indegree: Map<string, number>;
  adjacency: Map<string, string[]>;
  ready: string[];
  waitingHumanNodeId: string | null;
}

/**
 * 从事件投影重建调度记账，与运行期行为逐位等价：
 * - succeeded：恢复输出并结算出边（condition 按 selected 分支结算/剪枝）
 * - skipped：沿出边剪枝（killSubtree 永不 push ready，避免被剪子树误调度）
 * - suspended 且为挂起锚点：排除在 ready 外，下游靠入度饥饿不调度
 * - running：human 且已批准 = 已解决挂起；其余为崩溃残留 = 断点重跑
 * - failed：rearmFailedNodes 时视作待执行（失败断点重试路径）
 */
export function rebuildSchedulingWorkset(
  definition: WorkflowDefinition,
  projected: ProjectedRunState,
  options: { rearmFailedNodes: boolean },
): SchedulingWorkset {
  const adjacency = new Map<string, string[]>();
  const initialIndegree = new Map<string, number>();
  for (const node of definition.nodes) {
    adjacency.set(node.id, []);
    initialIndegree.set(node.id, 0);
  }
  for (const edge of definition.edges) {
    if (!initialIndegree.has(edge.source) || !initialIndegree.has(edge.target)) continue;
    initialIndegree.set(edge.target, (initialIndegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }

  const indegree = new Map(initialIndegree);
  const ready: string[] = [];
  const nodeOutputs: Record<string, unknown> = {};
  const workset: SchedulingWorkset = {
    nodeOutputs,
    indegree,
    adjacency,
    ready,
    waitingHumanNodeId: null,
  };

  const isRunnable = (id: string): boolean => {
    const state = projected.nodes.get(id);
    const status = state?.status ?? 'idle';
    if (status === 'idle') return true;
    if (status === 'running') {
      // human 且已批准 = 已解决挂起，禁止重跑
      const node = definition.nodes.find((item) => item.id === id);
      return !(node?.type === 'human' && state?.approved === true);
    }
    return status === 'failed' && options.rearmFailedNodes;
  };
  // 正常结算：减一；归零且目标可执行则 push 进 ready
  const settleDecrement = (target: string): void => {
    const remaining = (indegree.get(target) ?? 0) - 1;
    indegree.set(target, remaining);
    if (remaining === 0 && isRunnable(target)) ready.push(target);
  };
  // 剪枝链记账：等价于运行期 skipDownstream——减一，仅当恰好归零时递归；永不 push ready。
  // 幂等：condition 回放与 skipped 节点回放可能对同一子树各触发一次（菱形汇合），
  // 不去重会把汇合点入度双扣导致其永不 ready
  const killedSubtrees = new Set<string>();
  const killSubtree = (id: string): void => {
    if (killedSubtrees.has(id)) return;
    killedSubtrees.add(id);
    for (const target of adjacency.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) killSubtree(target);
    }
  };

  // 种子：原始入度为 0 且可执行的节点
  for (const node of definition.nodes) {
    if ((initialIndegree.get(node.id) ?? 0) === 0 && isRunnable(node.id)) ready.push(node.id);
  }

  let lastUpstreamOutput: unknown = null;
  let hasLastUpstream = false;
  for (const node of topoSort(definition.nodes, definition.edges)) {
    const state = projected.nodes.get(node.id);
    if (!state) continue;
    switch (state.status) {
      case 'succeeded': {
        nodeOutputs[node.id] = { output: state.output };
        lastUpstreamOutput = state.output;
        hasLastUpstream = true;
        if (node.type === 'condition') {
          const output =
            state.output !== null && typeof state.output === 'object'
              ? (state.output as { selected?: unknown })
              : null;
          const selected = typeof output?.selected === 'string' ? output.selected : null;
          for (const edge of definition.edges.filter((item) => item.source === node.id)) {
            if (selected !== null && edge.sourceHandle === selected) {
              settleDecrement(edge.target);
            } else {
              killSubtree(edge.target);
            }
          }
        } else {
          for (const target of adjacency.get(node.id) ?? []) settleDecrement(target);
        }
        break;
      }
      case 'skipped':
        killSubtree(node.id);
        break;
      case 'suspended':
        if (projected.waitingHumanNodeId === node.id) workset.waitingHumanNodeId = node.id;
        break;
      case 'running': {
        if (node.type === 'human' && state.approved === true) {
          nodeOutputs[node.id] = { output: state.humanInput ?? null };
          lastUpstreamOutput = state.humanInput ?? null;
          hasLastUpstream = true;
          for (const target of adjacency.get(node.id) ?? []) settleDecrement(target);
        }
        // 其余 running = 崩溃残留，不动作；入度归零时进 ready（断点重跑语义）
        break;
      }
      default:
        break;
    }
  }
  if (hasLastUpstream) nodeOutputs['__last_upstream__'] = { output: lastUpstreamOutput };
  return workset;
}

function parseRunInput(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);
  private readonly running = new Set<string>();
  /** 前一轮退出前收到重入请求的 run：需在前一轮结束后补跑一轮 */
  private readonly pendingRounds = new Set<string>();
  /** 调度轮次纪元：控制面意图（暂停/取消）绑定纪元，过期意图不会被新一轮消费 */
  private readonly epochs = new Map<string, number>();
  /** 暂停/取消意图：runId -> 发起时的调度轮次纪元 */
  private readonly pauseRequested = new Map<string, number>();
  private readonly cancelRequested = new Map<string, number>();
  /** 控制面互斥：同一 run 的控制动作串行执行，双击审批/并发 resume 不会写重复事件 */
  private readonly controlLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventStore: EventStore,
    private readonly llmAdapter: LlmAdapter,
    private readonly mcpRegistry: McpRegistryService,
    private readonly runsService: RunsService,
  ) {}

  /** 控制面互斥包装：按 runId 排队执行，防止并发控制请求各自读到过期投影 */
  private async withControlLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.controlLocks.get(runId) ?? Promise.resolve();
    const next = previous.then(action, action);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.controlLocks.set(runId, tail);
    void tail.then(() => {
      if (this.controlLocks.get(runId) === tail) this.controlLocks.delete(runId);
    });
    return next;
  }

  /** 调度入口（可重入）：回放事件重建状态后从断点继续；前一轮仍在执行时登记补跑，避免恢复事件被静默丢弃 */
  async execute(runId: string): Promise<void> {
    if (this.running.has(runId)) {
      this.pendingRounds.add(runId);
      return;
    }
    this.running.add(runId);
    try {
      do {
        this.pendingRounds.delete(runId);
        const epoch = (this.epochs.get(runId) ?? 0) + 1;
        this.epochs.set(runId, epoch);
        try {
          await this.doExecute(runId, epoch);
        } catch (error) {
          this.logger.error(`run ${runId} 调度器异常: ${String(error)}`);
          await this.terminate(runId, 'RUN_FAILED', {
            error: `调度器异常: ${error instanceof Error ? error.message : String(error)}`,
          }).catch((terminateError: unknown) => {
            // 终态事件落库失败只能记录：投影停留 running，重启后由崩溃对账兜底
            this.logger.error(`run ${runId} 终态事件落库失败: ${String(terminateError)}`);
          });
          break;
        }
      } while (this.pendingRounds.has(runId));
    } finally {
      this.running.delete(runId);
      this.epochs.delete(runId);
      // 残留意图（含收尾窗口内到达的）随本轮一并清除，绝不污染下一次执行
      this.pauseRequested.delete(runId);
      this.cancelRequested.delete(runId);
    }
  }

  /* ---------------- 控制面：三条恢复路径 + 暂停/取消 ---------------- */

  /** 主动暂停：登记纪元化内存标志，主循环在调度间隙停机后补发 RUN_SUSPENDED */
  async pause(runId: string): Promise<void> {
    await this.runsService.ensureRun(runId);
    if (!this.running.has(runId)) throw new ConflictException('运行不在执行中，无法暂停');
    this.pauseRequested.set(runId, this.epochs.get(runId) ?? 0);
  }

  /** 取消：在跑则设标志由主循环收尾发 RUN_CANCELED；不在跑则直接追加 */
  async cancel(runId: string): Promise<void> {
    await this.runsService.ensureRun(runId);
    if (this.running.has(runId)) {
      this.cancelRequested.set(runId, this.epochs.get(runId) ?? 0);
      return;
    }
    await this.withControlLock(runId, async () => {
      const { projected } = await this.loadProjection(runId);
      if (isTerminalRunStatus(projected.status)) {
        throw new ConflictException('运行已处于终态，无法取消');
      }
      await this.appendEvent(runId, 'RUN_CANCELED', { reason: 'user' });
      await this.runsService.syncFromProjection(runId);
    });
  }

  /**
   * 查询控制面意图：暂停/取消「已请求但尚未生效」时对应字段为 true。
   * 供 run summary/详情 DTO 暴露给前端轮询展示「等待生效」反馈；
   * 进程内内存态，进程重启后丢失（可接受）。
   */
  getControlIntent(runId: string): { pauseRequested: boolean; cancelRequested: boolean } {
    return {
      pauseRequested: this.pauseRequested.has(runId),
      cancelRequested: this.cancelRequested.has(runId),
    };
  }

  /** 恢复：suspended（主动暂停 / 崩溃）→ 追加 RUN_RESUMED 后重入调度 */
  async resume(runId: string): Promise<void> {
    await this.withControlLock(runId, async () => {
      await this.runsService.ensureRun(runId);
      const { projected } = await this.loadProjection(runId);
      if (projected.status !== 'suspended') {
        throw new ConflictException('仅挂起状态的运行可恢复');
      }
      await this.appendEvent(runId, 'RUN_RESUMED', { mode: 'resume' });
      void this.execute(runId).catch(() => undefined);
    });
  }

  /** 失败断点重试：failed 节点重新武装后从断点继续 */
  async retryFailed(runId: string): Promise<void> {
    await this.withControlLock(runId, async () => {
      await this.runsService.ensureRun(runId);
      const { projected } = await this.loadProjection(runId);
      if (projected.status !== 'failed') {
        throw new ConflictException('仅失败的运行可从断点重试');
      }
      await this.appendEvent(runId, 'RUN_RESUMED', { mode: 'retry_failed' });
      void this.execute(runId).catch(() => undefined);
    });
  }

  /** Human 审批：批准则恢复执行；拒绝则直接落 NODE_FAILED + RUN_FAILED（不重入引擎） */
  async submitHumanInput(runId: string, request: HumanInputRequest): Promise<void> {
    await this.withControlLock(runId, async () => {
      await this.runsService.ensureRun(runId);
      const { projected, events } = await this.loadProjection(runId);
      if (projected.status !== 'waiting_human' || projected.waitingHumanNodeId === null) {
        throw new ConflictException('运行不在等待人工输入状态');
      }
      const nodeId = projected.waitingHumanNodeId;
      await this.appendEvent(runId, 'HUMAN_INPUT_RECEIVED', {
        nodeId,
        approved: request.approved === true,
        input: request.input ?? null,
      });
      if (!request.approved) {
        const nodeType = this.humanWaitingNodeType(events, nodeId);
        await this.appendEvent(runId, 'NODE_FAILED', { nodeId, nodeType, error: '审批被拒绝' });
        await this.terminate(runId, 'RUN_FAILED', { error: `节点 ${nodeId} 失败: 审批被拒绝` });
        return;
      }
      await this.appendEvent(runId, 'RUN_RESUMED', { mode: 'human' });
      // 补发 human 节点成功事件：挂起已由 HUMAN_INPUT_RECEIVED 解决，
      // 缺少 NODE_SUCCEEDED 会让投影永远停留在 running（且后续回放丢失该节点输出）
      const nodeType = this.humanWaitingNodeType(events, nodeId);
      const okSeq = await this.appendEvent(runId, 'NODE_SUCCEEDED', {
        nodeId,
        nodeType,
        output: truncateForEvent(request.input ?? null),
      });
      await this.appendEvent(runId, 'CHECKPOINT_SAVED', { seq: okSeq });
      void this.execute(runId).catch(() => undefined);
    });
  }

  private humanWaitingNodeType(events: WorkflowEvent[], nodeId: string): string {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event || event.type !== 'HUMAN_WAITING') continue;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (payload.nodeId === nodeId && typeof payload.nodeType === 'string') {
        return payload.nodeType;
      }
    }
    return '';
  }

  private async loadProjection(
    runId: string,
  ): Promise<{ projected: ProjectedRunState; events: WorkflowEvent[] }> {
    const events = await this.eventStore.readEvents(runId);
    return { projected: projectRunState(runId, events), events };
  }

  private async appendEvent(
    runId: string,
    type: WorkflowEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.eventStore.append(runId, type, payload);
  }

  private async doExecute(runId: string, epoch: number): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) {
      this.logger.error(`run ${runId} 不存在，调度终止`);
      return;
    }

    // 定义优先快照；快照为空（旧数据）回退当前工作流定义
    let definitionRaw = run.definitionSnapshot;
    if (definitionRaw === null) {
      const workflow = await this.prisma.workflow.findUnique({
        where: { id: run.workflowId },
      });
      definitionRaw = workflow?.definition ?? null;
    }
    if (definitionRaw === null) {
      await this.terminate(runId, 'RUN_FAILED', { error: `工作流定义缺失: ${run.workflowId}` });
      return;
    }
    let definition: WorkflowDefinition;
    try {
      definition = JSON.parse(definitionRaw) as WorkflowDefinition;
    } catch {
      await this.terminate(runId, 'RUN_FAILED', { error: '工作流定义解析失败' });
      return;
    }

    const validation = validateWorkflowDefinition(definition);
    if (!validation.valid) {
      await this.terminate(runId, 'RUN_FAILED', {
        error: `定义校验失败: ${validation.errors.join('; ')}`,
      });
      return;
    }

    const { events, projected } = await this.loadProjection(runId);
    if (isTerminalRunStatus(projected.status)) return; // 幂等守卫：终态运行不再调度

    // 最后一次 RUN_RESUMED 的模式决定 failed 节点是否重新武装
    let resumedMode: string | null = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type === 'RUN_RESUMED') {
        const mode = (event.payload ?? {}) as Record<string, unknown>;
        resumedMode = typeof mode.mode === 'string' ? mode.mode : null;
        break;
      }
    }
    const rearmFailedNodes = resumedMode === 'retry_failed';

    const workset = rebuildSchedulingWorkset(definition, projected, { rearmFailedNodes });

    // 事件写入走 EventStore 的 per-run 串行队列：seq 分配与落库原子完成，
    // 与控制面（暂停/恢复/审批）的并发写入不会撞 (runId, seq) 唯一约束
    const emit: EmitFn = async (type, payload) => {
      const event = await this.eventStore.append(runId, type, payload);
      return event.seq;
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

    const nodeOutputs = workset.nodeOutputs;
    const variables: Record<string, unknown> = {};
    for (const variable of definition.variables ?? []) {
      variables[variable.name] = variable.default ?? null;
    }
    const input = parseRunInput(run.input);

    // 终止标志：任一节点失败或挂起即停止调度新节点
    let aborted = false;
    let humanSuspended = false;
    let pauseSeen = false;
    /** 首个失败节点现场：run 级终态延迟到收尾统一落库时取其错误信息。
     *  用对象持有（节点闭包内赋值、收尾读取），避免 TS 把捕获变量收窄成 null */
    const failureRef: {
      current: {
        nodeId: string;
        message: string;
        errorCategory?: string;
        errorHint?: string;
        upstreamExcerpt?: string;
      } | null;
    } = { current: null };

    const stopDispatching = (): boolean =>
      aborted ||
      humanSuspended ||
      this.cancelRequested.get(runId) === epoch ||
      this.pauseRequested.get(runId) === epoch;

    const ready = workset.ready;
    let cursor = 0;
    const inflight = new Set<Promise<void>>();

    const onNodeSettled = (nodeId: string): void => {
      for (const target of workset.adjacency.get(nodeId) ?? []) {
        const remaining = (workset.indegree.get(target) ?? 0) - 1;
        workset.indegree.set(target, remaining);
        if (remaining === 0 && !aborted && !humanSuspended) ready.push(target);
      }
    };

    const executeNode = async (nodeId: string): Promise<void> => {
      const node = nodeById.get(nodeId);
      if (!node) return;

      await emit('NODE_STARTED', { nodeId, nodeType: node.type });
      const context: TemplateContext = { input, variables, nodeOutputs };

      try {
        const result = await this.runWithResilience(
          node,
          () => executorFactory(node.type)({ node, context, emit }),
          emit,
        );

        if (result.suspended) {
          humanSuspended = true;
          const suspendSeq = await emit('RUN_SUSPENDED', { nodeId, reason: 'human' });
          await emit('CHECKPOINT_SAVED', { seq: suspendSeq });
          return;
        }

        nodeOutputs[nodeId] = { output: result.output };
        nodeOutputs['__last_upstream__'] = { output: result.output };
        const okSeq = await emit('NODE_SUCCEEDED', {
          nodeId,
          nodeType: node.type,
          output: truncateForEvent(result.output),
        });
        await emit('CHECKPOINT_SAVED', { seq: okSeq });

        if (node.type === 'condition') {
          const selected = (result.output as { selected?: string } | null)?.selected;
          if (typeof selected !== 'string') throw new Error('Condition 输出缺少 selected 分支');
          // 剪枝：仅 selected 分支的出边生效，其余分支下游发 SKIPPED
          for (const edge of edges.filter((item) => item.source === nodeId)) {
            if (edge.sourceHandle === selected) {
              const remaining = (workset.indegree.get(edge.target) ?? 0) - 1;
              workset.indegree.set(edge.target, remaining);
              if (remaining === 0) ready.push(edge.target);
            } else {
              const skipSeq = await emit('NODE_SKIPPED', {
                nodeId: edge.target,
                nodeType: nodeById.get(edge.target)?.type ?? '',
              });
              await emit('CHECKPOINT_SAVED', { seq: skipSeq });
              skipDownstream(edge.target);
            }
          }
          return;
        }

        onNodeSettled(nodeId);
      } catch (error) {
        aborted = true;
        const message = error instanceof Error ? error.message : String(error);
        const llmFields = extractLlmErrorFields(error);
        if (failureRef.current === null) failureRef.current = { nodeId, message, ...llmFields };
        try {
          const failSeq = await emit('NODE_FAILED', {
            nodeId,
            nodeType: node.type,
            error: message,
            ...llmFields,
          });
          await emit('CHECKPOINT_SAVED', { seq: failSeq });
        } catch (emitError) {
          // NODE_FAILED 落库失败：记录现场，由收尾的 terminate / 调度器兜底路径落终态
          this.logger.error(`run ${runId} 节点 ${nodeId} 失败事件落库失败: ${String(emitError)}`);
        }
        // 注意：run 级 RUN_FAILED 不在此处落库——并行场景下其他 in-flight 节点
        // 还会照常结算，终态必须等收尾（所有 in-flight settle 后）统一落库，
        // 否则 SSE 收到终态即关流，事件流里会出现「终态之后的事件」
      }
    };

    const skipDownstream = (nodeId: string): void => {
      for (const target of workset.adjacency.get(nodeId) ?? []) {
        const remaining = (workset.indegree.get(target) ?? 0) - 1;
        workset.indegree.set(target, remaining);
        if (remaining === 0) skipDownstream(target);
      }
    };

    // 主循环：并发执行就绪节点；暂停/取消在调度间隙生效
    while (cursor < ready.length || inflight.size > 0) {
      if (this.pauseRequested.get(runId) === epoch) pauseSeen = true;
      while (cursor < ready.length && !stopDispatching()) {
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

    // 收尾优先级：取消 > 暂停 > 失败 > Human 挂起 > 历史挂起锚点 > 完成
    const wasCanceled = this.cancelRequested.get(runId) === epoch;
    this.cancelRequested.delete(runId);
    this.pauseRequested.delete(runId);

    if (wasCanceled) {
      await this.terminate(runId, 'RUN_CANCELED', { reason: 'user' });
      return;
    }
    if (pauseSeen && !aborted && !humanSuspended) {
      await this.terminate(runId, 'RUN_SUSPENDED', { reason: 'paused' });
      return;
    }
    if (aborted) {
      // 终态延迟落库：此处所有 in-flight 节点已 settle（上方 allSettled），
      // 慢节点的结算事件（NODE_SUCCEEDED/CHECKPOINT_SAVED 等）已先于 RUN_FAILED 落库，
      // 事件流里不会出现「终态之后的事件」。terminate 幂等（终态屏障）：
      // 并行多节点同时失败也只落一条 RUN_FAILED。
      const failure = failureRef.current;
      await this.terminate(runId, 'RUN_FAILED', {
        error: failure ? `节点 ${failure.nodeId} 失败: ${failure.message}` : '运行失败',
        ...(failure
          ? {
              errorCategory: failure.errorCategory,
              errorHint: failure.errorHint,
              upstreamExcerpt: failure.upstreamExcerpt,
            }
          : {}),
      });
      return;
    }
    if (humanSuspended) {
      await this.runsService.syncFromProjection(runId);
      return;
    }
    if (workset.waitingHumanNodeId !== null) {
      // 恢复轮次仍有未决的历史挂起锚点（如崩溃于 waiting_human 后被误重入）
      await this.runsService.syncFromProjection(runId);
      return;
    }

    const endNode = nodes.find((node) => node.type === 'end');
    const endOutput = endNode ? nodeOutputs[endNode.id] : undefined;
    const output =
      endOutput && typeof endOutput === 'object' && 'output' in endOutput ? endOutput.output : null;
    await this.terminate(runId, 'RUN_COMPLETED', { output });
  }

  /** 韧性包装：单次尝试超时 + 指数退避重试；Human 节点直接透传（挂起即业务语义） */
  private async runWithResilience(
    node: WorkflowNode,
    attempt: () => Promise<NodeExecutionResult>,
    emit: EmitFn,
  ): Promise<NodeExecutionResult> {
    if (node.type === 'human') return attempt();
    const policy = normalizeRetryPolicy(node.retry);
    const maxAttempts = policy?.maxAttempts ?? 1;
    const timeoutMs =
      typeof node.timeoutMs === 'number' && node.timeoutMs > 0 ? node.timeoutMs : null;

    for (let current = 1; ; current += 1) {
      try {
        return await withTimeout(
          attempt(),
          timeoutMs,
          `节点 ${node.id} 执行超时(${String(timeoutMs)}ms)`,
        );
      } catch (error) {
        if (current >= maxAttempts || policy === null) throw error;
        const delayMs = retryDelayMs(policy, current);
        await emit('NODE_RETRYING', {
          nodeId: node.id,
          nodeType: node.type,
          attempt: current + 1,
          maxAttempts,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delayMs);
      }
    }
  }

  private async terminate(
    runId: string,
    type: 'RUN_COMPLETED' | 'RUN_FAILED' | 'RUN_CANCELED' | 'RUN_SUSPENDED',
    payload: Record<string, unknown>,
  ): Promise<void> {
    // 终态屏障：事件流已终态（RUN_COMPLETED/FAILED/CANCELED）时跳过追加，
    // 保证终态事件由单一写者落库、至多一条（RUN_SUSPENDED 可多次，不在屏障内）
    const appended = await this.eventStore.appendTerminal(runId, type, payload);
    if (appended === null) {
      this.logger.warn(`run ${runId} 已处于终态，忽略重复的 ${type} 事件`);
    }
    await this.runsService.syncFromProjection(runId);
  }
}
