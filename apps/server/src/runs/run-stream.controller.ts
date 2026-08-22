import { Controller, Param, Req, Sse } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, type Observer } from 'rxjs';
import type { WorkflowEvent } from '@flowagent/shared';

import { EventStore } from '../engine/event-store.service';
import { RunsService } from './runs.service';

const TERMINAL_EVENT_TYPES = new Set(['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELED']);
const HEARTBEAT_MS = 15_000;

/**
 * SSE 事件流：先订阅、后回放、再冲缓冲（seq 去重），关闭"回放与订阅之间丢事件"的窗口；
 * 断线重连经浏览器自动携带的 Last-Event-ID 从断点续传，避免全量重放。
 */
@Controller()
export class RunStreamController {
  constructor(
    private readonly runsService: RunsService,
    private readonly eventStore: EventStore,
  ) {}

  @Sse('runs/:id/stream')
  stream(@Param('id') id: string, @Req() request: Request): Observable<MessageEvent> {
    const lastEventIdHeader = Number(request.headers['last-event-id'] ?? 0);
    const fromSeq = Number.isFinite(lastEventIdHeader) && lastEventIdHeader > 0 ? lastEventIdHeader : 0;

    return new Observable<MessageEvent>((observer: Observer<MessageEvent>) => {
      let lastSeq = fromSeq;
      let closed = false;
      let live = false;
      /** 订阅早于回放启动期间暂存的事件（回放后按 seq 去重冲刷） */
      const buffered: WorkflowEvent[] = [];
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const push = (event: WorkflowEvent): void => {
        if (closed) return;
        // id 字段让浏览器在重连时自动携带 Last-Event-ID
        observer.next({ id: String(event.seq), data: event, type: 'event' } as unknown as MessageEvent);
      };

      const finishIfTerminal = (event: WorkflowEvent): boolean => {
        if (!TERMINAL_EVENT_TYPES.has(event.type)) return false;
        observer.next({
          data: { done: true, status: event.type },
          type: 'done',
        } as MessageEvent);
        observer.complete();
        return true;
      };

      // 1. 先订阅（注册之前的落库事件才不会漏）
      unsubscribe = this.eventStore.subscribe(id, (event) => {
        if (event.seq <= lastSeq) return;
        if (!live) {
          buffered.push(event);
          return;
        }
        push(event);
        lastSeq = event.seq;
        if (finishIfTerminal(event)) cleanup();
      });

      const cleanup = (): void => {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };

      void (async () => {
        try {
          // 2. 回放历史（从 Last-Event-ID 之后）
          const history = await this.eventStore.readEvents(id, fromSeq);
          if (closed) return;
          for (const event of history) {
            push(event);
            lastSeq = event.seq;
            if (finishIfTerminal(event)) {
              cleanup();
              return;
            }
          }

          // 3. 冲刷订阅缓冲（与历史按 seq 去重），此后进入实时推送
          for (const event of buffered.splice(0)) {
            if (event.seq <= lastSeq) continue;
            push(event);
            lastSeq = event.seq;
            if (finishIfTerminal(event)) {
              cleanup();
              return;
            }
          }
          live = true;

          // 4. 心跳注释帧：防止代理/负载均衡器掐断空闲连接
          heartbeat = setInterval(() => {
            if (!closed) observer.next({ data: { heartbeat: true }, type: 'heartbeat' } as MessageEvent);
          }, HEARTBEAT_MS);
        } catch (error) {
          cleanup();
          observer.error(error);
        }
      })();

      return () => cleanup();
    });
  }
}
