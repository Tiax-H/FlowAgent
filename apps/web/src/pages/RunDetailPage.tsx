import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunSummary, WorkflowEvent } from '@flowagent/shared';

import { runsApi } from '../api/runs';
import { foldReplayState } from '../runs/fold';
import { eventLabel } from '../lib/eventLabels';
import {
  Button,
  CopyButton,
  LoadingRows,
  NodeStatusBadge,
  RunStatusBadge,
} from '../components/ui';

/** 时间轴最多渲染最近多少条事件（超出提示总数，避免长 run 冻结 DOM） */
const MAX_VISIBLE_EVENTS = 500;

/** 这些事件默认展开完整 payload（失败原因、人工审批上下文最常被查看） */
const DEFAULT_EXPANDED_EVENT_TYPES = new Set<string>(['RUN_FAILED', 'NODE_FAILED', 'HUMAN_WAITING']);

/** 输入/输出面板超过多少行时默认限高滚动 */
const IO_COLLAPSED_LINES = 8;

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

/** fetch 错误中文化：网络层失败（TypeError）单独提示，其余透传原始消息 */
function toUserMessage(cause: unknown): string {
  return cause instanceof TypeError
    ? '无法连接服务器，请确认 server 已启动'
    : cause instanceof Error
      ? cause.message
      : String(cause);
}

/** 完整 payload 的格式化 JSON（时间轴展开区展示用） */
function stringifyPayload(payload: unknown): string {
  return JSON.stringify(payload ?? {}, null, 2);
}

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

/** 输入/输出只读面板：标题行带复制按钮；超过 IO_COLLAPSED_LINES 行默认限高滚动，可「展开全部」 */
function IoPanel({ title, text }: { title: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = useMemo(() => text.split('\n').length > IO_COLLAPSED_LINES, [text]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {title}
        </h2>
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-700"
          >
            {expanded ? '收起' : '展开全部'}
          </button>
        )}
        <CopyButton text={text} />
      </div>
      <pre
        className={`whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 text-[10px] leading-relaxed ${
          collapsible && !expanded ? 'max-h-40 overflow-auto' : ''
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

export function RunDetailPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  /** 详情首次加载是否完成（完成前用骨架行兜底） */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 控制操作成功后的短暂提示 */
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [humanInputText, setHumanInputText] = useState('');
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [streamConnected, setStreamConnected] = useState(true);
  /** 用户手动展开/收起过的事件行（seq → 是否展开；未出现时按事件类型默认值） */
  const [expandedSeqs, setExpandedSeqs] = useState<Record<number, boolean>>({});
  const timelineRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<WorkflowEvent[]>([]);
  /** 事件摘要缓存（按 seq）：大 payload 的 stringify 只在事件到达时做一次 */
  const summaryCacheRef = useRef<Map<number, string>>(new Map());
  /** 完整 payload JSON 缓存（按 seq），供展开区渲染 */
  const payloadJsonCacheRef = useRef<Map<number, string>>(new Map());
  const noticeTimerRef = useRef<number | null>(null);

  const isTerminal = summary !== null && TERMINAL_STATUSES.includes(summary.status);
  const replayActive = isTerminal && replayCursor !== null;

  // 操作成功后的"已提交"提示自动消失
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const flashNotice = (text: string): void => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setActionNotice(text);
    noticeTimerRef.current = window.setTimeout(() => setActionNotice(null), 2500);
  };

  // 初始加载 + SSE 实时流（控制动作与手动重试后经 streamEpoch 重订；断线交给浏览器自动重连，
  // 服务端按 Last-Event-ID 从断点续传，不重放全量）
  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;

    eventsRef.current = [];
    summaryCacheRef.current = new Map();
    payloadJsonCacheRef.current = new Map();
    setEvents([]);
    setExpandedSeqs({});
    setLoading(true);

    void runsApi
      .get(runId)
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(toUserMessage(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    source = new EventSource(`/api/runs/${runId}/stream`);
    source.onopen = () => setStreamConnected(true);
    let errorSummaryFetched = false;
    source.addEventListener('event', (message) => {
      if (disposed) return;
      const event = JSON.parse((message as MessageEvent).data) as WorkflowEvent;
      // 按 seq 去重（重连后服务端续传可能短窗重复）
      if (eventsRef.current.some((existing) => existing.seq === event.seq)) return;
      eventsRef.current = [...eventsRef.current, event];
      summaryCacheRef.current.set(event.seq, eventSummary(event));
      payloadJsonCacheRef.current.set(event.seq, stringifyPayload(event.payload));
      setEvents(eventsRef.current);
    });
    source.addEventListener('done', () => {
      source?.close();
      setStreamConnected(false);
      void runsApi
        .get(runId)
        .then(setSummary)
        .catch(() => undefined);
    });
    source.onerror = () => {
      // 不 close：EventSource 自动指数退避重连并携带 Last-Event-ID 续传；
      // 仅在 run 已终态（流已被 done 关闭）时静默
      if (summary && TERMINAL_STATUSES.includes(summary.status)) return;
      setStreamConnected(false);
      // 自动重连期间 onerror 会反复触发：兜底 summary 只拉一次，重连成功靠 onopen 恢复
      if (!errorSummaryFetched) {
        errorSummaryFetched = true;
        void runsApi
          .get(runId)
          .then(setSummary)
          .catch(() => undefined);
      }
    };

    return () => {
      disposed = true;
      source?.close();
    };
    // summary 仅用于终态判断（onerror 静默），不作为重订触发器
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

  const runAction = (action: () => Promise<unknown>, onSuccess?: () => void): void => {
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    action()
      .then(() => {
        onSuccess?.();
        flashNotice('已提交');
        void runsApi
          .get(runId)
          .then(setSummary)
          .catch(() => undefined);
        void runsApi
          .events(runId)
          .then((fresh) => {
            eventsRef.current = fresh;
            summaryCacheRef.current = new Map(fresh.map((event) => [event.seq, eventSummary(event)]));
            payloadJsonCacheRef.current = new Map(
              fresh.map((event) => [event.seq, stringifyPayload(event.payload)]),
            );
            setEvents(fresh);
          })
          .catch(() => undefined);
        setStreamEpoch((epoch) => epoch + 1);
      })
      .catch((cause: unknown) => {
        setActionError(toUserMessage(cause));
      })
      .finally(() => setBusy(false));
  };

  const submitHuman = (approved: boolean): void => {
    if (!approved && !window.confirm('拒绝将使本次运行直接失败（不可恢复），确定拒绝？')) {
      return;
    }
    runAction(
      () => runsApi.humanInput(runId, { approved, input: parseHumanInputText(humanInputText) }),
      // 成功后才清空输入：失败时保留用户写的审批意见
      () => setHumanInputText(''),
    );
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
        {summary && <RunStatusBadge status={summary.status} />}
        {summary && <span className="text-xs text-neutral-400">v{summary.workflowVersion}</span>}

        {/* 操作栏：failed 仍提供断点重试；其余非终态提供取消/暂停/恢复 */}
        {summary && (summary.status === 'failed' || !TERMINAL_STATUSES.includes(summary.status)) && (
          <div className="ml-auto flex items-center gap-2">
            {summary.status === 'running' && (
              <Button variant="secondary" disabled={busy} onClick={() => runAction(() => runsApi.pause(runId))}>
                暂停
              </Button>
            )}
            {summary.status === 'suspended' && (
              <Button variant="accent" disabled={busy} onClick={() => runAction(() => runsApi.resume(runId))}>
                恢复
              </Button>
            )}
            {summary.status === 'failed' && (
              <Button variant="accent" disabled={busy} onClick={() => runAction(() => runsApi.retry(runId))}>
                从断点重试
              </Button>
            )}
            {summary.status !== 'failed' && (
              <Button variant="dangerOutline" disabled={busy} onClick={() => runAction(() => runsApi.cancel(runId))}>
                取消
              </Button>
            )}
          </div>
        )}
        {isTerminal && summary.status !== 'failed' && (
          <button
            type="button"
            onClick={replayToggle}
            className="ml-auto rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
          >
            {replayActive ? '退出回放' : '回放时间轴'}
          </button>
        )}
        {isTerminal && summary.status === 'failed' && (
          <button
            type="button"
            onClick={replayToggle}
            className="ml-2 rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
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
            placeholder="可填写审批意见或补充信息（纯文本或 JSON）"
            rows={2}
            className="mt-2 w-full max-w-xl rounded border border-pink-200 bg-white px-2 py-1 text-xs"
          />
          <div className="mt-2 flex gap-2">
            <Button variant="accent" disabled={busy} onClick={() => submitHuman(true)}>
              批准并继续
            </Button>
            <Button variant="dangerOutline" disabled={busy} onClick={() => submitHuman(false)}>
              拒绝
            </Button>
          </div>
        </section>
      )}

      {/* 详情加载失败：黄条 + 重试 */}
      {error && !summary && !loading && (
        <div className="flex items-center gap-3 bg-yellow-50 px-4 py-2 text-sm text-yellow-700">
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              setStreamEpoch((epoch) => epoch + 1);
            }}
          >
            重试
          </Button>
        </div>
      )}
      {actionError && (
        <p className="bg-red-50 px-4 py-2 text-sm text-red-600">操作失败：{actionError}</p>
      )}
      {actionNotice && <p className="bg-green-50 px-4 py-2 text-sm text-green-700">{actionNotice}</p>}
      {!streamConnected && !isTerminal && (
        <p className="bg-yellow-50 px-4 py-2 text-xs text-yellow-700">
          实时连接已断开，正在自动重连（服务恢复后会从断点继续接收事件）…
        </p>
      )}

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

      {loading && !summary ? (
        /* 详情加载中的骨架兜底 */
        <div className="flex min-h-0 flex-1 items-start justify-center p-6">
          <div className="w-full max-w-md">
            <LoadingRows rows={5} />
          </div>
        </div>
      ) : (
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
                      <span className="ml-auto">
                        <NodeStatusBadge status={node.status} />
                      </span>
                    </div>
                    <code className="block truncate text-[10px] text-neutral-400">{node.nodeId}</code>
                    {node.error && <p className="truncate text-[10px] text-red-500">{node.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* 事件时间轴（回放时游标之后的事件淡化；超长时只渲染最近 N 条；行可点击展开完整 payload） */}
          <div ref={timelineRef} className="min-w-0 flex-1 overflow-auto bg-neutral-50 p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              事件时间轴（{events.length}
              {events.length > MAX_VISIBLE_EVENTS ? `，仅显示最近 ${MAX_VISIBLE_EVENTS} 条` : ''}）
            </h2>
            <ol className="space-y-1">
              {events.slice(-MAX_VISIBLE_EVENTS).map((event) => {
                const dimmed = replayActive && event.seq > (replayCursor ?? 0);
                const defaultExpanded = DEFAULT_EXPANDED_EVENT_TYPES.has(event.type);
                const expanded = expandedSeqs[event.seq] ?? defaultExpanded;
                return (
                  <li
                    key={`${event.seq}-${String(event.id ?? '')}`}
                    className={`overflow-hidden rounded bg-white text-xs shadow-sm transition-opacity ${dimmed ? 'opacity-30' : ''}`}
                  >
                    <button
                      type="button"
                      aria-expanded={expanded}
                      title={event.type}
                      onClick={() =>
                        setExpandedSeqs((prev) => ({ ...prev, [event.seq]: !expanded }))
                      }
                      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-neutral-50"
                    >
                      <span className="w-8 shrink-0 text-right font-mono text-[10px] text-neutral-300">
                        {event.seq}
                      </span>
                      <span
                        className={`w-28 shrink-0 font-semibold ${EVENT_TYPE_COLORS[event.type] ?? 'text-neutral-600'}`}
                      >
                        {eventLabel(event.type)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-neutral-600">
                        {summaryCacheRef.current.get(event.seq) ?? eventSummary(event)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-neutral-300">
                        {new Date(event.timestamp).toLocaleTimeString('zh-CN')}
                      </span>
                      <span className="shrink-0 text-[10px] text-neutral-400">
                        {expanded ? '▾ 收起' : '▸ 展开'}
                      </span>
                    </button>
                    {expanded && (
                      <pre className="mx-3 mb-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 font-mono text-[10px] leading-relaxed text-neutral-700">
                        {payloadJsonCacheRef.current.get(event.seq) ?? stringifyPayload(event.payload)}
                      </pre>
                    )}
                  </li>
                );
              })}
              {events.length === 0 && <li className="text-xs text-neutral-400">等待事件…</li>}
            </ol>
          </div>

          {/* 输入输出 */}
          <aside className="w-64 shrink-0 space-y-3 overflow-auto border-l border-neutral-200 bg-white p-3">
            <IoPanel title="输入" text={summary ? JSON.stringify(summary.input, null, 2) : '…'} />
            <IoPanel
              title="输出"
              text={summary?.output != null ? JSON.stringify(summary.output, null, 2) : '—'}
            />
            {summary?.error && (
              <div>
                <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-400">
                  错误
                </h2>
                <pre className="overflow-auto whitespace-pre-wrap break-all rounded bg-red-50 p-2 text-[10px] leading-relaxed text-red-600">
                  {summary.error}
                </pre>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
