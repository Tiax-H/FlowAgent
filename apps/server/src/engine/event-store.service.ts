/**
 * Event Store：append-only 事件存取（SQLite，经 Prisma）。
 *
 * 红线：事件表禁止 UPDATE/DELETE；本模块只提供 append 与读。
 *
 * 并发契约：同一 run 的所有写入者（调度器 emit、控制面 resume/pause/human-input、
 * 启动与崩溃对账）共用一条 per-run 串行队列，seq 分配与落库在临界区内原子完成，
 * 从机制上杜绝 (runId, seq) 撞号（多进程部署不在支持范围，见 docs）。
 */
import { Injectable } from '@nestjs/common';
import type { WorkflowEvent, WorkflowEventType } from '@flowagent/shared';

import { PrismaService } from '../prisma/prisma.service';

interface EventRow {
  id: number;
  runId: string;
  seq: number;
  type: string;
  payload: string;
  createdAt: Date;
}

/** 事件流层面的终态类型：出现后不允许再写任何事件（屏障语义） */
const TERMINAL_EVENT_TYPES = new Set<string>(['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELED']);

export type TerminalEventType = 'RUN_COMPLETED' | 'RUN_FAILED' | 'RUN_CANCELED' | 'RUN_SUSPENDED';

function toEvent(row: EventRow): WorkflowEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    type: row.type as WorkflowEventType,
    payload,
    timestamp: row.createdAt.toISOString(),
  };
}

export type EventSubscriber = (event: WorkflowEvent) => void;

@Injectable()
export class EventStore {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  /** per-run 追加串行队列（既是并发防线，也保证 SSE 推送顺序） */
  private readonly appendQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly prisma: PrismaService) {}

  private enqueueAppend<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.appendQueues.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.appendQueues.set(runId, tail);
    // 队列消化完且无新写入时清理 entry，避免 Map 随 run 数无界增长
    void tail.then(() => {
      if (this.appendQueues.get(runId) === tail) this.appendQueues.delete(runId);
    });
    return next;
  }

  /** 追加事件；seq 在串行临界区内分配（基于当前最大 seq），返回带实际 seq 的事件 */
  append(
    runId: string,
    type: WorkflowEventType,
    payload: unknown,
  ): Promise<WorkflowEvent> {
    return this.enqueueAppend(runId, async () => {
      const seq = await this.nextSeq(runId);
      const row = await this.prisma.workflowEvent.create({
        data: { runId, seq, type, payload: JSON.stringify(payload ?? {}) },
      });
      const event = toEvent(row);
      this.notifySubscribers(event);
      return event;
    });
  }

  /**
   * 追加终态事件（屏障）：若事件流中已存在任一 RUN_COMPLETED/RUN_FAILED/RUN_CANCELED，
   * 跳过写入（幂等），返回 null。检查与写入在同一临界区内，多写者并发也只会落一条终态。
   *
   * 注意必须查"流中是否已有终态"而非"流尾是否为终态"：终态之后 in-flight 节点的
   * 结算事件（NODE_FAILED/CHECKPOINT_SAVED 等）仍会追加（§9.2 的既定语义），
   * 只查流尾会被这些事件挡住而漏检，导致双终态穿透（失败被后到的取消覆盖翻转）。
   */
  appendTerminal(
    runId: string,
    type: TerminalEventType,
    payload: unknown,
  ): Promise<WorkflowEvent | null> {
    return this.enqueueAppend(runId, async () => {
      const existing = await this.prisma.workflowEvent.findFirst({
        where: { runId, type: { in: [...TERMINAL_EVENT_TYPES] } },
        select: { seq: true },
      });
      if (existing) return null;
      const seq = await this.nextSeq(runId);
      const row = await this.prisma.workflowEvent.create({
        data: { runId, seq, type, payload: JSON.stringify(payload ?? {}) },
      });
      const event = toEvent(row);
      this.notifySubscribers(event);
      return event;
    });
  }

  async readEvents(runId: string, fromSeq = 0): Promise<WorkflowEvent[]> {
    const rows = await this.prisma.workflowEvent.findMany({
      where: { runId, seq: { gt: fromSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map(toEvent);
  }

  async nextSeq(runId: string): Promise<number> {
    const last = await this.prisma.workflowEvent.findFirst({
      where: { runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return (last?.seq ?? 0) + 1;
  }

  /** SSE 实时订阅；返回退订函数 */
  subscribe(runId: string, subscriber: EventSubscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(subscriber);
    return () => {
      set?.delete(subscriber);
      if (set && set.size === 0) this.subscribers.delete(runId);
    };
  }

  private notifySubscribers(event: WorkflowEvent): void {
    const set = this.subscribers.get(event.runId);
    if (!set) return;
    for (const subscriber of set) {
      try {
        subscriber(event);
      } catch {
        // 订阅方异常不影响事件写入
      }
    }
  }
}
