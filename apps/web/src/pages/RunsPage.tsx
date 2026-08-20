import { useCallback, useEffect, useState } from 'react';
import type { RunSummary } from '@flowagent/shared';

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

export function RunsPage({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRuns(await runsApi.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-6">
      <h2 className="mb-4 text-sm font-medium text-neutral-600">运行历史</h2>
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {runs.length === 0 && !error && (
        <p className="text-sm text-neutral-400">暂无运行，从编辑器发起一次运行</p>
      )}
      <ul className="space-y-2">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onOpenRun(run.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-left transition-colors hover:border-neutral-400"
            >
              <span className="text-sm font-medium">{run.workflowName}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[run.status] ?? ''}`}
              >
                {STATUS_LABELS[run.status] ?? run.status}
              </span>
              <span className="text-xs text-neutral-400">v{run.workflowVersion}</span>
              <span className="ml-auto text-xs text-neutral-400">
                {run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '—'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
