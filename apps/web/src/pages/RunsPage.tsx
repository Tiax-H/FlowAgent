import { useCallback, useEffect, useState } from 'react';
import type { RunSummary } from '@flowagent/shared';

import { runsApi } from '../api/runs';
import { Button, EmptyState, LoadingRows, RunStatusBadge } from '../components/ui';

/** fetch 错误中文化：网络层失败（TypeError）单独提示，其余透传原始消息 */
function toUserMessage(cause: unknown): string {
  return cause instanceof TypeError
    ? '无法连接服务器，请确认 server 已启动'
    : cause instanceof Error
      ? cause.message
      : String(cause);
}

export function RunsPage({
  onOpenRun,
  onGoWorkflows,
}: {
  onOpenRun: (runId: string) => void;
  onGoWorkflows?: () => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 首次加载是否已完成（完成前显示骨架行，避免闪现空状态） */
  const [initialLoaded, setInitialLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRuns(await runsApi.list());
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

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-6">
      <h2 className="mb-4 text-sm font-medium text-neutral-600">运行历史</h2>
      {error && (
        <div className="mb-3 flex items-center gap-3 rounded bg-red-50 px-3 py-2 text-sm text-red-600">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="secondary" onClick={() => void refresh()}>
            重试
          </Button>
        </div>
      )}
      {!initialLoaded ? (
        <LoadingRows rows={4} />
      ) : runs.length === 0 && !error ? (
        <EmptyState
          title="还没有运行记录"
          description="在编辑器里打开一个工作流，点 ▶ 运行 即可发起"
          action={
            onGoWorkflows ? (
              <Button variant="primary" onClick={onGoWorkflows}>
                去工作流列表
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onOpenRun(run.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-left transition-colors hover:border-neutral-400"
              >
                <span className="text-sm font-medium">{run.workflowName}</span>
                <RunStatusBadge status={run.status} />
                <span className="text-xs text-neutral-400">v{run.workflowVersion}</span>
                <span className="ml-auto text-xs text-neutral-400">
                  {run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
