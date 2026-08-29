import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { RunSummary, WorkflowEvent } from '@flowagent/shared';

import { PrismaService } from '../prisma/prisma.service';
import { EventStore } from '../engine/event-store.service';
import { emptyRunState, projectRunState } from '../engine/projection';

interface RunRow {
  id: string;
  workflowId: string;
  workflowVersion: number;
  input: string | null;
  definitionSnapshot: string | null;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  /** 软删标记：非空表示已被用户删除（列表/详情/SSE 一律按 404 处理） */
  hiddenAt: Date | null;
}

/** 控制面意图：暂停/取消已请求但尚未生效（引擎内存标志，进程重启后丢失） */
export interface RunControlIntent {
  pauseRequested: boolean;
  cancelRequested: boolean;
}

/**
 * 运行详情 DTO = 共享 RunSummary + 控制面意图标志。
 * pauseRequested/cancelRequested 仅在「已请求但尚未生效」时为 true（缺省即 false），
 * 前端据此展示「暂停已请求，将在当前节点结束后生效」。
 * workflowDeleted 仅在所属工作流记录已不存在时为 true（缺省即 false），
 * 前端据此在运行详情页展示「原工作流已删除」横幅。
 */
export interface RunDetailSummary extends RunSummary {
  /** 暂停已请求但尚未生效：将在当前节点结束后落 RUN_SUSPENDED */
  pauseRequested?: boolean;
  /** 取消已请求但尚未生效：将在当前节点结束后落 RUN_CANCELED */
  cancelRequested?: boolean;
  /** 所属工作流记录已不存在（如历史遗留的孤儿 run）：前端展示「原工作流已删除」横幅 */
  workflowDeleted?: boolean;
}

/** 运行列表默认返回条数 */
export const RUNS_LIST_DEFAULT_LIMIT = 100;
/** 运行列表单次返回条数上限 */
export const RUNS_LIST_MAX_LIMIT = 500;

/**
 * 解析运行列表 ?limit= 查询参数：非法（非正整数/空）回退默认 100，超过 500 截断为 500。
 * 与控制器共用，保证「非法值回退默认」只有一份实现。
 */
export function parseRunsListLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return RUNS_LIST_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return RUNS_LIST_DEFAULT_LIMIT;
  return Math.min(parsed, RUNS_LIST_MAX_LIMIT);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class RunsService implements OnModuleInit {
  private readonly logger = new Logger(RunsService.name);
  /** 引擎注册的启动回调（避免循环依赖由 EngineModule 桥接 set） */
  private runStarter: ((runId: string) => Promise<void>) | null = null;
  /** 引擎注册的控制面意图查询（避免循环依赖由 EngineModule 桥接 set） */
  private controlIntentProvider: ((runId: string) => RunControlIntent) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventStore: EventStore,
  ) {}

  onModuleInit(): void {
    // 进程重启时对孤儿 run 追加崩溃挂起事件，恢复方式为用户手动调 resume API
    void this.reconcileOrphanRuns().catch((error: unknown) => {
      this.logger.warn(`孤儿 run 状态对账失败: ${String(error)}`);
    });
  }

  setRunStarter(starter: (runId: string) => Promise<void>): void {
    this.runStarter = starter;
  }

  /** 引擎桥接：注册控制面意图查询（EngineModule.onModuleInit 调用） */
  setControlIntentProvider(provider: (runId: string) => RunControlIntent): void {
    this.controlIntentProvider = provider;
  }

  /** 读取 run 的控制面意图；引擎未桥接（单测/降级场景）时一律 false */
  private controlIntent(runId: string): RunControlIntent {
    const provider = this.controlIntentProvider;
    if (!provider) return { pauseRequested: false, cancelRequested: false };
    return provider(runId);
  }

  /** 启动一次运行：落库（含定义快照）+ 交给引擎执行 */
  async startRun(workflowId: string, input: unknown): Promise<string> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new NotFoundException(`工作流不存在: ${workflowId}`);

    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId,
        workflowVersion: workflow.version,
        input: JSON.stringify(input ?? null),
        definitionSnapshot: workflow.definition,
        status: 'pending',
      },
    });
    await this.eventStore.append(run.id, 'RUN_STARTED', {
      workflowId,
      workflowVersion: workflow.version,
      input: input ?? null,
    });
    await this.syncFromProjection(run.id).catch(() => undefined);

    if (this.runStarter) {
      void this.runStarter(run.id).catch(() => undefined);
    }
    return run.id;
  }

  /**
   * 运行列表：直接读 workflow_runs 投影缓存列（syncFromProjection 维护）。
   * 列表页每 3 秒轮询，绝不能逐 run 全量回放事件（那是 O(runs × events) 的放大器）；
   * 节点级明细留给详情页（getRun）。缓存列在运行中由控制面动作刷新，
   * 状态变化粒度（running→终态）对本页足够。
   * 软删（hiddenAt 非空）的 run 不出现在列表中。
   * limit 为返回条数（须经 parseRunsListLimit 规范化：默认 100、上限 500），
   * 按现有 createdAt 倒序取前 N；所属工作流已删除的 run 额外携带 workflowDeleted: true。
   */
  async listRuns(
    workflowId?: string,
    limit: number = RUNS_LIST_DEFAULT_LIMIT,
  ): Promise<RunDetailSummary[]> {
    const rows = await this.prisma.workflowRun.findMany({
      where: workflowId ? { workflowId, hiddenAt: null } : { hiddenAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const workflowIds = [...new Set(rows.map((row) => row.workflowId))];
    const workflows = await this.prisma.workflow.findMany({
      where: { id: { in: workflowIds } },
      select: { id: true, name: true },
    });
    const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
    return rows.map((row) => {
      const name = names.get(row.workflowId);
      return this.toCachedSummary(row, name ?? '(已删除)', name === undefined);
    });
  }

  /** 轻量状态查询（bridge 轮询用）：只读缓存列，零事件回放 */
  async getRunStatus(runId: string): Promise<{ id: string; status: string }> {
    const row = await this.ensureRun(runId);
    return { id: row.id, status: row.status };
  }

  /** 运行详情：所属工作流已删除时携带 workflowDeleted: true 供前端展示横幅 */
  async getRun(runId: string): Promise<RunDetailSummary> {
    const row = await this.ensureRun(runId);
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: row.workflowId },
      select: { name: true },
    });
    return this.toSummary(row, workflow?.name ?? '(已删除)', workflow === null);
  }

  async getEvents(runId: string): Promise<WorkflowEvent[]> {
    await this.ensureRun(runId);
    return this.eventStore.readEvents(runId);
  }

  /**
   * 运行存在性校验的唯一入口：不存在或已软删（hiddenAt 非空）一律 404，
   * 详情/事件/SSE/控制面动作共用，保证已删 run 对外完全不可见。
   */
  async ensureRun(runId: string): Promise<RunRow> {
    const row = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!row) throw new NotFoundException(`运行不存在: ${runId}`);
    if (row.hiddenAt !== null) throw new NotFoundException(`运行已删除: ${runId}`);
    return row;
  }

  /**
   * 删除运行（软删）：仅给投影缓存行打 hiddenAt 标记。
   * 硬约束：事件表 append-only，禁止 UPDATE/DELETE——删除不做任何事件清理，
   * 列表/详情/SSE 经 ensureRun/listRuns 过滤后按 404 处理。
   */
  async deleteRun(runId: string): Promise<void> {
    await this.ensureRun(runId);
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { hiddenAt: new Date() },
    });
  }

  /** 用事件投影刷新 run 的缓存字段（引擎在终止事件后调用）；可传入已算好的投影省一次回放 */
  async syncFromProjection(
    runId: string,
    state?: ReturnType<typeof projectRunState>,
  ): Promise<void> {
    const projected = state ?? projectRunState(runId, await this.eventStore.readEvents(runId));
    await this.prisma.workflowRun
      .update({
        where: { id: runId },
        data: {
          status: projected.status,
          output: JSON.stringify(projected.output ?? null),
          error: projected.error,
          startedAt: projected.startedAt ? new Date(projected.startedAt) : null,
          endedAt: projected.endedAt ? new Date(projected.endedAt) : null,
        },
      })
      .catch(() => undefined);
  }

  /** 崩溃对账：DB 缓存为 pending/running 的孤儿 run，若事件流仍非终态则追加 RUN_SUSPENDED(crash) */
  private async reconcileOrphanRuns(): Promise<void> {
    const orphans = await this.prisma.workflowRun.findMany({
      where: { status: { in: ['pending', 'running'] }, hiddenAt: null },
      select: { id: true },
    });
    for (const orphan of orphans) {
      const events = await this.eventStore.readEvents(orphan.id);
      const state = projectRunState(orphan.id, events);
      if (state.status === 'pending' || state.status === 'running') {
        // append-only 安全：waiting_human 被 fold 守卫保护，终态投影仅重同步不追加
        await this.eventStore.append(orphan.id, 'RUN_SUSPENDED', { reason: 'crash' });
      }
      await this.syncFromProjection(orphan.id, state);
    }
  }

  /** 纯缓存列摘要（列表页）：nodes 为空，节点明细见 getRun；工作流缺失时带 workflowDeleted 标志 */
  private toCachedSummary(
    row: RunRow,
    workflowName: string,
    workflowDeleted: boolean,
  ): RunDetailSummary {
    const summary: RunDetailSummary = {
      id: row.id,
      workflowId: row.workflowId,
      workflowName,
      workflowVersion: row.workflowVersion,
      status: row.status,
      input: parseJson<unknown>(row.input, null),
      output: parseJson<unknown>(row.output, null),
      error: row.error,
      nodes: [],
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      waitingHuman: null,
    };
    if (workflowDeleted) summary.workflowDeleted = true;
    this.applyControlIntent(summary, row.id);
    return summary;
  }

  /** 暴露控制面意图：仅「已请求但尚未生效」时置 true（缺省即 false，避免前端把常态当状态展示） */
  private applyControlIntent(summary: RunDetailSummary, runId: string): void {
    const intent = this.controlIntent(runId);
    if (intent.pauseRequested) summary.pauseRequested = true;
    if (intent.cancelRequested) summary.cancelRequested = true;
  }

  private async toSummary(
    row: RunRow,
    workflowName: string,
    workflowDeleted: boolean,
  ): Promise<RunDetailSummary> {
    const events = await this.eventStore.readEvents(row.id);
    const state = events.length > 0 ? projectRunState(row.id, events) : emptyRunState(row.id);

    const nodeMetas = await this.loadNodeMetas(row.workflowId);
    const nodes = [...state.nodes.values()].map((node) => ({
      nodeId: node.nodeId,
      nodeType: nodeMetas.get(node.nodeId)?.type ?? 'unknown',
      name: nodeMetas.get(node.nodeId)?.name ?? node.nodeId,
      status: node.status,
      error: node.error,
    }));

    const summary: RunDetailSummary = {
      id: row.id,
      workflowId: row.workflowId,
      workflowName,
      workflowVersion: row.workflowVersion,
      status: state.status,
      input: parseJson<unknown>(row.input, null),
      output: state.output,
      error: state.error,
      nodes,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      waitingHuman: this.resolveWaitingHuman(state, events, nodeMetas),
    };
    if (workflowDeleted) summary.workflowDeleted = true;
    this.applyControlIntent(summary, row.id);
    return summary;
  }

  /** waiting_human 时从最后一条 HUMAN_WAITING 事件提取挂起节点摘要 */
  private resolveWaitingHuman(
    state: ReturnType<typeof projectRunState>,
    events: WorkflowEvent[],
    nodeMetas: Map<string, { id: string; type: string; name: string }>,
  ): RunSummary['waitingHuman'] {
    if (state.status !== 'waiting_human' || !state.waitingHumanNodeId) return null;
    const nodeId = state.waitingHumanNodeId;
    let prompt = '';
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event) continue;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === 'HUMAN_WAITING' && payload.nodeId === nodeId) {
        prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        break;
      }
    }
    return {
      nodeId,
      nodeType: nodeMetas.get(nodeId)?.type ?? 'unknown',
      name: nodeMetas.get(nodeId)?.name ?? nodeId,
      prompt,
    };
  }

  /** 节点元信息（type/name）缓存加载；按工作流 version 失效，编辑保存后自动刷新 */
  private nodeMetaCache = new Map<
    string,
    { version: number; metas: Array<{ id: string; type: string; name: string }> }
  >();

  private async loadNodeMetas(
    workflowId: string,
  ): Promise<Map<string, { id: string; type: string; name: string }>> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { definition: true, version: true },
    });
    const cached = this.nodeMetaCache.get(workflowId);
    if (cached && cached.version === workflow?.version) {
      return new Map(cached.metas.map((meta) => [meta.id, meta] as const));
    }
    const definition = parseJson<{
      nodes?: Array<{ id: string; type: string; name: string }>;
    } | null>(workflow?.definition ?? null, null);
    const metas = definition?.nodes ?? [];
    if (workflow) this.nodeMetaCache.set(workflowId, { version: workflow.version, metas });
    return new Map(metas.map((meta) => [meta.id, meta] as const));
  }
}
