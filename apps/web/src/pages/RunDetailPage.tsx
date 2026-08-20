import { useEffect, useRef, useState } from 'react';
import type { RunSummary, WorkflowEvent } from '@flowagent/shared';

import { runsApi } from '../api/runs';

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-500',
  running: 'bg-blue-100 text-blue-700',
  suspended: 'bg-yellow-100 text-yellow-700',
  waiting_human: 'bg-pink-100 text-pink-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  canceled: 'bg-neutral-100 text-neutral-500',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  suspended: '已挂起',
  waiting_human: '等待人工',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

const NODE_STATUS_STYLES: Record<string, string> = {
  idle: 'bg-neutral-100 text-neutral-500',
  running: 'bg-blue-100 text-blue-700',
  succeeded: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-neutral-200 text-neutral-400',
  suspended: 'bg-pink-100 text-pink-700',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  RUN_STARTED: 'text-blue-600',
  RUN_COMPLETED: 'text-green-600',
  RUN_FAILED: 'text-red-600',
  RUN_SUSPENDED: 'text-yellow-600',
  RUN_RESUMED: 'text-blue-600',
  RUN_CANCELED: 'text-neutral-500',
  NODE_STARTED: 'text-blue-500',
  NODE_SUCCEEDED: 'text-green-500',
  NODE_FAILED: 'text-red-500',
  NODE_SKIPPED: 'text-neutral-400',
  LLM_REQUESTED: 'text-violet-500',
  LLM_TOKEN: 'text-violet-400',
  LLM_COMPLETED: 'text-violet-600',
  TOOL_CALLED: 'text-amber-600',
  TOOL_RESULT: 'text-amber-500',
  HUMAN_WAITING: 'text-pink-600',
  HUMAN_INPUT_RECEIVED: 'text-pink-500',
  CHECKPOINT_SAVED: 'text-teal-500',
};

function eventSummary(event: WorkflowEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof payload.nodeId === 'string') parts.push(payload.nodeId);
  if (typeof payload.provider === 'string' && typeof payload.model === 'string') {
    parts.push(`${payload.provider}/${payload.model}`);
  }
  if (typeof payload.server === 'string' && typeof payload.tool === 'string') {
    parts.push(`${payload.server}:${payload.tool}`);
  }
  if (typeof payload.error === 'string') parts.push(payload.error);
  if (typeof payload.content === 'string') parts.push(payload.content.slice(0, 120));
  if (payload.output !== undefined) parts.push(JSON.stringify(payload.output).slice(0, 120));
  return parts.join(' · ');
}

export function RunDetailPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<WorkflowEvent[]>([]);

  // 初始加载 + SSE 实时流
  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;

    void runsApi
      .get(runId)
      .then(setSummary)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    source = new EventSource(`/api/runs/${runId}/stream`);
    source.addEventListener('event', (message) => {
      if (disposed) return;
      const event = JSON.parse((message as MessageEvent).data) as WorkflowEvent;
      eventsRef.current = [...eventsRef.current, event];
      setEvents(eventsRef.current);
    });
    source.addEventListener('done', () => {
      source?.close();
      void runsApi
        .get(runId)
        .then(setSummary)
        .catch(() => undefined);
    });
    source.onerror = () => {
      // 后端不可达或流结束；轮询兜底一次最终状态
      source?.close();
      void runsApi
        .get(runId)
        .then(setSummary)
        .catch(() => undefined);
    };

    return () => {
      disposed = true;
      source?.close();
    };
  }, [runId]);

  // 自动滚动到底部
  useEffect(() => {
    const element = timelineRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [events]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          ← 返回
        </button>
        <h1 className="text-sm font-semibold">{summary ? summary.workflowName : runId}</h1>
        {summary && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[summary.status] ?? ''}`}
          >
            {STATUS_LABELS[summary.status] ?? summary.status}
          </span>
        )}
        {summary && <span className="text-xs text-neutral-400">v{summary.workflowVersion}</span>}
      </header>

      {error && <p className="bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}

      <div className="flex min-h-0 flex-1">
        {/* 节点状态看板 */}
        <aside className="w-64 shrink-0 overflow-auto border-r border-neutral-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            节点看板
          </h2>
          {!summary || summary.nodes.length === 0 ? (
            <p className="text-xs text-neutral-400">暂无节点状态</p>
          ) : (
            <ul className="space-y-1.5">
              {summary.nodes.map((node) => (
                <li key={node.nodeId} className="rounded border border-neutral-200 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-neutral-700">
                      {node.name}
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${NODE_STATUS_STYLES[node.status] ?? NODE_STATUS_STYLES.idle}`}
                    >
                      {node.status}
                    </span>
                  </div>
                  <code className="block truncate text-[10px] text-neutral-400">{node.nodeId}</code>
                  {node.error && <p className="truncate text-[10px] text-red-500">{node.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* 事件时间轴 */}
        <div ref={timelineRef} className="min-w-0 flex-1 overflow-auto bg-neutral-50 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            事件时间轴（{events.length}）
          </h2>
          <ol className="space-y-1">
            {events.map((event) => (
              <li
                key={`${event.seq}`}
                className="flex items-baseline gap-2 rounded bg-white px-3 py-1.5 text-xs shadow-sm"
              >
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-neutral-300">
                  {event.seq}
                </span>
                <span
                  className={`w-36 shrink-0 font-mono text-[11px] font-semibold ${EVENT_TYPE_COLORS[event.type] ?? 'text-neutral-600'}`}
                >
                  {event.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-600">
                  {eventSummary(event)}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-neutral-300">
                  {new Date(event.timestamp).toLocaleTimeString('zh-CN')}
                </span>
              </li>
            ))}
            {events.length === 0 && <li className="text-xs text-neutral-400">等待事件…</li>}
          </ol>
        </div>

        {/* 输入输出 */}
        <aside className="w-64 shrink-0 space-y-3 overflow-auto border-l border-neutral-200 bg-white p-3">
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              输入
            </h2>
            <pre className="overflow-auto rounded bg-neutral-50 p-2 text-[10px]">
              {summary ? JSON.stringify(summary.input, null, 2) : '…'}
            </pre>
          </div>
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              输出
            </h2>
            <pre className="overflow-auto rounded bg-neutral-50 p-2 text-[10px]">
              {summary?.output != null ? JSON.stringify(summary.output, null, 2) : '—'}
            </pre>
          </div>
          {summary?.error && (
            <div>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-400">
                错误
              </h2>
              <pre className="overflow-auto rounded bg-red-50 p-2 text-[10px] text-red-600">
                {summary.error}
              </pre>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
