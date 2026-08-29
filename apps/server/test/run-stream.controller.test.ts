/** SSE 流端点回归（UX 问题 17）：不存在/已删除的 run 返回 404，而不是 200 挂 0 事件连接 */
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { EventStore } from '../src/engine/event-store.service';
import { RunStreamController } from '../src/runs/run-stream.controller';
import { PrismaService } from '../src/prisma/prisma.service';

const fakeRequest = { headers: {} } as never;

/** 真 EventStore + 内存 workflow_events 表（subscribe/notify 契约与生产一致） */
function makeEventStore(): EventStore {
  const rows: Array<{
    id: number;
    runId: string;
    seq: number;
    type: string;
    payload: string;
    createdAt: Date;
  }> = [];
  const prismaStub = {
    workflowEvent: {
      findFirst: async () => rows.slice().sort((a, b) => b.seq - a.seq)[0] ?? null,
      findMany: async ({ where }: { where?: { runId?: string; seq?: { gt?: number } } }) =>
        rows
          .filter(
            (row) =>
              (where?.runId === undefined || row.runId === where.runId) &&
              row.seq > (where?.seq?.gt ?? 0),
          )
          .sort((a, b) => a.seq - b.seq),
      create: async ({
        data,
      }: {
        data: { runId: string; seq: number; type: string; payload: string };
      }) => {
        const row = { id: rows.length + 1, createdAt: new Date(), ...data };
        rows.push(row);
        return { ...row };
      },
    },
  } as unknown as PrismaService;
  return new EventStore(prismaStub);
}

function missingRunService(): { ensureRun: () => Promise<never> } {
  return {
    ensureRun: async () => {
      throw new NotFoundException('运行不存在: run_missing');
    },
  };
}

describe('RunStreamController SSE', () => {
  it('不存在的 run → 404（NotFoundException，中文 message）', async () => {
    const controller = new RunStreamController(
      missingRunService() as never,
      {} as unknown as EventStore,
    );
    await expect(controller.stream('run_missing', fakeRequest)).rejects.toThrow(
      new NotFoundException('运行不存在: run_missing'),
    );
  });

  it('已删除的 run → 404（ensureRun 统一拦截）', async () => {
    const runsService = {
      ensureRun: async () => {
        throw new NotFoundException('运行已删除: run_gone');
      },
    };
    const controller = new RunStreamController(runsService as never, {} as unknown as EventStore);
    await expect(controller.stream('run_gone', fakeRequest)).rejects.toThrow(
      new NotFoundException('运行已删除: run_gone'),
    );
  });

  it('存在的 run → 返回 SSE Observable，历史事件可回放', async () => {
    const store = makeEventStore();
    await store.append('run_1', 'RUN_STARTED', { workflowId: 'wf_1' });
    const runsService = {
      ensureRun: async () => ({ id: 'run_1', hiddenAt: null }),
    };
    const controller = new RunStreamController(
      runsService as never,
      store as unknown as EventStore,
    );

    const stream = await controller.stream('run_1', fakeRequest);
    expect(typeof stream.subscribe).toBe('function');

    const received: Array<{ type: string; data: unknown }> = [];
    await new Promise<void>((resolve) => {
      const subscription = stream.subscribe((message) => {
        received.push(message as { type: string; data: unknown });
        subscription.unsubscribe();
        resolve();
      });
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('event');
  });
});
