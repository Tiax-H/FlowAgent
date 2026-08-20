/**
 * Event Store：append-only 事件存取（SQLite，经 Prisma）。
 *
 * 红线：事件表禁止 UPDATE/DELETE；本模块只提供 append 与读。
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

  constructor(private readonly prisma: PrismaService) {}

  /** 追加事件；seq 由调用方（引擎串行分配）保证运行内唯一 */
  async append(runId: string, seq: number, type: WorkflowEventType, payload: unknown): Promise<WorkflowEvent> {
    const row = await this.prisma.workflowEvent.create({
      data: { runId, seq, type, payload: JSON.stringify(payload ?? {}) },
    });
    const event = toEvent(row);
    this.notifySubscribers(event);
    return event;
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
