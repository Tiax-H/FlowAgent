import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunSummary, WorkflowEvent } from '@flowagent/shared';

import { runsApi } from '../api/runs';
import { foldReplayState } from '../runs/fold';

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
  NODE_RETRYING: 'text-orange-500',
  LLM_REQUESTED: 'text-violet-500',
  LLM_TOKEN: 'text-violet-400',
  LLM_COMPLETED: 'text-violet-600',
  TOOL_CALLED: 'text-amber-600',
  TOOL_RESULT: 'text-amber-500',
  HUMAN_WAITING: 'text-pink-600',
  HUMAN_INPUT_RECEIVED: 'text-pink-500',
  CHECKPOINT_SAVED: 'text-teal-500',
};

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'];

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
  if (payload.attempt !== undefined && typeof payload.error === 'string') {
    parts.push(`第 ${String(payload.attempt)}/${String(payload.maxAttempts)} 次`);
  }
  if (typeof payload.error === 'string') parts.push(payload.error);
  if (typeof payload.content === 'string') parts.push(payload.content.slice(0, 120));
  if (payload.output !== undefined) parts.push(JSON.stringify(payload.output).slice(0, 120));
  return parts.join(' · ');
}

/** 审批输入框文本 → 请求体 input：能解析为 JSON 就解析，否则按原字符串提交 */
function parseHumanInputText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export function RunDetailPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [humanInputText, setHumanInputText] = useState('');
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<WorkflowEvent[]>([]);

  const isTerminal = summary !== null && TERMINAL_STATUSES.includes(summary.status);
  const replayActive = isTerminal && replayCursor !== null;

  // 初始加载 + SSE 实时流（控制动作后经 streamEpoch 重订，覆盖 resume 后的新事件）
  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;

    eventsRef.current = [];
    setEvents([]);

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
  }, [runId, streamEpoch]);

  // 自动滚动到底部（仅实时模式）
  useEffect(() => {
    if (replayActive) return;
    const element = timelineRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [events, replayActive]);

  // 回放播放：定时推进游标
  useEffect(() => {
    if (!playing || replayCursor === null) return;
    if (replayCursor >= events.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setReplayCursor((cursor) => Math.min((cursor ?? 0) + 1, events.length)), 280);
    return () => clearTimeout(timer);
  }, [playing, replayCursor, events.length]);

  const runAction = (action: () => Promise<unknown>): void => {
    setBusy(true);
    setActionError(null);
    action()
      .then(() => {
        void runsApi
          .get(runId)
          .then(setSummary)
          .catch(() => undefined);
        void runsApi
          .events(runId)
          .then((fresh) => {
            eventsRef.current = fresh;
            setEvents(fresh);
          })
          .catch(() => undefined);
        setStreamEpoch((epoch) => epoch + 1);
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const submitHuman = (approved: boolean): void => {
    runAction(() =>
      runsApi.humanInput(runId, { approved, input: parseHumanInputText(humanInputText) }),
    );
    setHumanInputText('');
  };

  // 回放模式下节点看板取折叠状态；节点名沿用 summary 元数据
  const boardNodes = useMemo(() => {
    if (!replayActive) return summary?.nodes ?? [];
    const folded = foldReplayState(events.slice(0, replayCursor ?? 0));
    const metaById = new Map((summary?.nodes ?? []).map((node) => [node.nodeId, node] as const));
    return [...folded.nodes.values()].map((node) => ({
      nodeId: node.nodeId,
      nodeType: metaById.get(node.nodeId)?.nodeType ?? 'unknown',
      name: metaById.get(node.nodeId)?.name ?? node.nodeId,
      status: node.status,
      error: node.error,
    }));
  }, [replayActive, replayCursor, events, summary]);

  const replayToggle = (): void => {
    if (!isTerminal) return;
    setPlaying(false);
    setReplayCursor((cursor) => (cursor === null ? events.length : null));
  };

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

        {/* 操作栏：按运行状态条件渲染 */}
        {summary && !TERMINAL_STATUSES.includes(summary.status) && (
          <div className="ml-auto flex items-center gap-2">
            {summary.status === 'running' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(() => runsApi.pause(runId))}
                className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50"
              >
                暂停
              </button>
            )}
            {summary.status === 'suspended' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(() => runsApi.resume(runId))}
                className="rounded border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                恢复
              </button>
            )}
            {summary.status === 'failed' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(() => runsApi.retry(runId))}
                className="rounded border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                从断点重试
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => runsApi.cancel(runId))}
              className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
            >
              取消
            </button>
          </div>
        )}
        {isTerminal && (
          <button
            type="button"
            onClick={replayToggle}
            className="ml-auto rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
          >
            {replayActive ? '退出回放' : '回放时间轴'}
          </button>
        )}
      </header>

      {/* Human 审批表单 */}
      {summary?.status === 'waiting_human' && summary.waitingHuman && (
        <section className="border-b border-pink-100 bg-pink-50/60 px-4 py-3">
          <p className="text-sm font-medium text-pink-800">
            等待人工审批：{summary.waitingHuman.name}
            <span className="ml-2 font-mono text-[10px] text-pink-400">
              {summary.waitingHuman.nodeId}
            </span>
          </p>
          {summary.waitingHuman.prompt && (
            <p className="mt-1 text-xs text-pink-600">{summary.waitingHuman.prompt}</p>
          )}
          <textarea
            value={humanInputText}
            onChange={(changeEvent) => setHumanInputText(changeEvent.target.value)}
            placeholder="补充输入（可选，JSON 或纯文本）"
            rows={2}
            className="mt-2 w-full max-w-xl rounded border border-pink-200 bg-white px-2 py-1 text-xs"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => submitHuman(true)}
              className="rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
            >
              批准并继续
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => submitHuman(false)}
              className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        </section>
      )}

      {error && <p className="bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}
      {actionError && <p className="bg-orange-50 px-4 py-2 text-sm text-orange-600">{actionError}</p>}

      {/* 回放控件 */}
      {replayActive && (
        <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2">
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100"
          >
            {playing ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button
            type="button"
            onClick={() => setReplayCursor((cursor) => Math.max(0, (cursor ?? 0) - 1))}
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100"
          >
            |◀ 上一步
          </button>
          <button
            type="button"
            onClick={() =>
              setReplayCursor((cursor) => Math.min(events.length, (cursor ?? 0) + 1))
            }
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100"
          >
            下一步 ▶|
          </button>
          <input
            type="range"
            min={0}
            max={events.length}
            value={replayCursor ?? 0}
            onChange={(changeEvent) => {
              setPlaying(false);
              setReplayCursor(Number(changeEvent.target.value));
            }}
            className="min-w-0 flex-1"
          />
          <span className="shrink-0 font-mono text-[10px] text-neutral-400">
            {String(replayCursor ?? 0)}/{String(events.length)}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 节点状态看板（回放时随游标折叠） */}
        <aside className="w-64 shrink-0 overflow-auto border-r border-neutral-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            节点看板{replayActive ? '（回放）' : ''}
          </h2>
          {boardNodes.length === 0 ? (
            <p className="text-xs text-neutral-400">暂无节点状态</p>
          ) : (
            <ul className="space-y-1.5">
              {boardNodes.map((node) => (
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

        {/* 事件时间轴（回放时游标之后的事件淡化） */}
        <div ref={timelineRef} className="min-w-0 flex-1 overflow-auto bg-neutral-50 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            事件时间轴（{events.length}）
          </h2>
          <ol className="space-y-1">
            {events.map((event) => {
              const dimmed = replayActive && event.seq > (replayCursor ?? 0);
              return (
                <li
                  key={`${event.seq}-${String(event.id ?? '')}`}
                  className={`flex items-baseline gap-2 rounded bg-white px-3 py-1.5 text-xs shadow-sm transition-opacity ${dimmed ? 'opacity-30' : ''}`}
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
              );
            })}
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
