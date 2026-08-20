import { Controller, Param, Sse } from '@nestjs/common';
import { Observable, type Observer } from 'rxjs';
import type { WorkflowEvent } from '@flowagent/shared';

import { EventStore } from '../engine/event-store.service';
import { RunsService } from './runs.service';

@Controller()
export class RunStreamController {
  constructor(
    private readonly runsService: RunsService,
    private readonly eventStore: EventStore,
  ) {}

  /** SSE：先回放已存事件，再实时推送新增；run 终止后发结束帧并关流 */
  @Sse('runs/:id/stream')
  stream(@Param('id') id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((observer: Observer<MessageEvent>) => {
      let lastSeq = 0;
      let closed = false;
      let unsubscribe: (() => void) | null = null;

      const push = (event: WorkflowEvent): void => {
        if (closed) return;
        observer.next({ data: event, type: 'event' } as MessageEvent);
      };

      void (async () => {
        try {
          // 1. 回放历史事件
          const history = await this.eventStore.readEvents(id);
          for (const event of history) {
            push(event);
            lastSeq = event.seq;
          }

          // 已终止的 run：直接结束流
          const summary = await this.runsService.getRun(id);
          if (['completed', 'failed', 'canceled'].includes(summary.status)) {
            observer.next({
              data: { done: true, status: summary.status },
              type: 'done',
            } as MessageEvent);
            observer.complete();
            return;
          }

          // 2. 订阅实时事件
          unsubscribe = this.eventStore.subscribe(id, (event) => {
            if (event.seq > lastSeq) {
              push(event);
              lastSeq = event.seq;
            }
            if (
              event.type === 'RUN_COMPLETED' ||
              event.type === 'RUN_FAILED' ||
              event.type === 'RUN_CANCELED'
            ) {
              observer.next({
                data: { done: true, status: event.type },
                type: 'done',
              } as MessageEvent);
              observer.complete();
            }
          });
        } catch (error) {
          observer.error(error);
        }
      })();

      return () => {
        closed = true;
        unsubscribe?.();
      };
    });
  }
}
