import { useCallback, useEffect, useState } from 'react';

import { runsApi } from '../api/runs';
import { formatDuration, formatListTime, shortenText } from '../lib/format';
import type { RunSummaryWithFlags } from '../types';
import { Button, confirmDialog, EmptyState, LoadingRows, RunStatusBadge } from '../components/ui';

/** fetch 错误中文化：网络层失败（TypeError）单独提示，其余透传原始消息 */
function toUserMessage(cause: unknown): string {
  return cause instanceof TypeError
    ? '无法连接服务器，请确认 server 已启动'
    : cause instanceof Error
      ? cause.message
      : String(cause);
}

/** 列表拉取条数（后端默认 100、上限 500）：打满时提示「仅显示最近 N 条」 */
const LIST_LIMIT = 200;

type StatusFilter = 'all' | 'running' | 'completed' | 'failed' | 'suspended';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string; match: (status: string) => boolean }> = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'running', label: '运行中', match: (status) => status === 'running' || status === 'pending' },
  { key: 'completed', label: '成功', match: (status) => status === 'completed' },
  { key: 'failed', label: '失败', match: (status) => status === 'failed' },
  // 「挂起」含暂停与等待人工两类非终态
  {
    key: 'suspended',
    label: '挂起',
    match: (status) => status === 'suspended' || status === 'waiting_human',
  },
];

/** 运行耗时：running 等非终态显示已运行时长（至当前时刻），终态显示总时长 */
function runElapsed(run: RunSummaryWithFlags, now: number): string {
  if (!run.startedAt) return '—';
  const started = new Date(run.startedAt).getTime();
  if (Number.isNaN(started)) return '—';
  const ended = run.endedAt ? new Date(run.endedAt).getTime() : now;
  return formatDuration(Math.max(0, (Number.isNaN(ended) ? now : ended) - started));
}

export function RunsPage({
  onOpenRun,
  onGoWorkflows,
}: {
  onOpenRun: (runId: string) => void;
  onGoWorkflows?: () => void;
}) {
  const [runs, setRuns] = useState<RunSummaryWithFlags[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 首次加载是否已完成（完成前显示骨架行，避免闪现空状态） */
  const [initialLoaded, setInitialLoaded] = useState(false);
  /** 返回条数达到拉取上限：列表可能被截断 */
  const [truncated, setTruncated] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await runsApi.list(LIST_LIMIT);
      setRuns(list);
      setTruncated(list.length >= LIST_LIMIT);
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setInitialLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      // 后台标签页不轮询，避免对列表接口的无谓压力
      if (document.visibilityState === 'visible') void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleDelete(run: RunSummaryWithFlags) {
    const confirmed = await confirmDialog({
      title: `删除运行「${run.workflowName}」？`,
      description: '事件记录将一并移除，此操作不可恢复。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    setDeletingId(run.id);
    try {
      const result = await runsApi.remove(run.id);
      if (result === 'missing') {
        // 已被其他入口删除：提示后以服务端列表为准
        setError('该运行不存在或已被删除，列表已刷新');
        await refresh();
        return;
      }
      setRuns((previous) => previous.filter((item) => item.id !== run.id));
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setDeletingId(null);
    }
  }

  const now = Date.now();
  const filter = STATUS_FILTERS.find((item) => item.key === statusFilter) ?? STATUS_FILTERS[0]!;
  const visibleRuns = runs.filter((run) => filter.match(run.status));

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">运行历史</h2>
      </div>
      {error && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-danger-6 bg-danger-2 px-3 py-2 text-sm text-danger-11">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      )}
      {/* 状态筛选（前端过滤） */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
        <span className="mr-1 text-faint">状态：</span>
        {STATUS_FILTERS.map((item) => {
          const count = runs.filter((run) => item.match(run.status)).length;
          const active = statusFilter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setStatusFilter(item.key)}
              className={`h-7 rounded-full px-3 text-xs tabular-nums transition-colors ${
                active
                  ? 'bg-sand-12 font-medium text-white'
                  : 'text-muted-foreground hover:bg-muted-strong'
              }`}
            >
              {item.label}
              {item.key !== 'all' ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>
      {truncated && <p className="mb-3 text-xs text-faint">仅显示最近 {LIST_LIMIT} 条运行</p>}
      {!initialLoaded ? (
        <LoadingRows rows={4} />
      ) : runs.length === 0 && !error ? (
        <EmptyState
          title="还没有运行记录"
          description="在编辑器里打开一个工作流，点「运行」即可发起"
          action={
            onGoWorkflows ? (
              <Button variant="primary" onClick={onGoWorkflows}>
                去工作流列表
              </Button>
            ) : undefined
          }
        />
      ) : visibleRuns.length === 0 ? (
        <p className="text-sm text-muted-foreground">该状态下暂无运行记录</p>
      ) : (
        <ul className="space-y-3">
          {visibleRuns.map((run) => (
            <li
              key={run.id}
              className="flex items-center gap-3 rounded-lg border border-border-soft bg-card p-3.5 shadow-xs transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-sm"
            >
              <button
                type="button"
                onClick={() => onOpenRun(run.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">{run.workflowName}</span>
                  <RunStatusBadge status={run.status} />
                  <span className="shrink-0 rounded bg-muted-strong px-1 font-mono text-2xs text-muted-foreground">
                    v{run.workflowVersion}
                  </span>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-faint">
                    {run.startedAt ? formatListTime(run.startedAt) : '—'}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs">
                  <span className="shrink-0 tabular-nums text-faint">
                    耗时 {runElapsed(run, now)}
                  </span>
                  {run.status === 'failed' && (
                    <span
                      className="min-w-0 flex-1 truncate text-danger-11"
                      title={run.error ?? undefined}
                    >
                      {/* 错误摘要直接取列表接口的 error 字段（新事件已是中文摘要），截断展示、悬停看全文 */}
                      {run.error ? shortenText(run.error, 80) : '—'}
                    </span>
                  )}
                </div>
              </button>
              <span className="flex shrink-0 items-center gap-1">
                {run.status === 'waiting_human' && (
                  <button
                    type="button"
                    title="前往运行详情完成审批"
                    onClick={() => onOpenRun(run.id)}
                    className="shrink-0 rounded px-1.5 py-1 text-xs font-medium text-accent transition-colors hover:text-accent-hover"
                  >
                    去审批
                  </button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={deletingId === run.id}
                  title="删除该运行记录"
                  onClick={() => void handleDelete(run)}
                >
                  删除
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
