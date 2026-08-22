import { useCallback, useEffect, useState } from 'react';

import { runsApi } from './api/runs';
import { workflowsApi } from './api/workflows';
import { McpServersPage } from './pages/McpServersPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { WorkflowEditorPage } from './pages/WorkflowEditorPage';
import type { WorkflowRecord } from './workflow/types';

type Page =
  | { kind: 'workflows' }
  | { kind: 'mcp' }
  | { kind: 'runs' }
  | { kind: 'editor'; workflowId: string | null }
  | { kind: 'runDetail'; runId: string };

export function App() {
  const [page, setPage] = useState<Page>({ kind: 'workflows' });
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setWorkflows(await workflowsApi.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (page.kind === 'workflows') void refresh();
  }, [page.kind, refresh]);

  async function handleCreate() {
    try {
      const created = await workflowsApi.create({
        name: `工作流 ${new Date().toLocaleDateString('zh-CN')}`,
        definition: {
          schemaVersion: 1,
          nodes: [
            { id: 'start', type: 'start', name: '开始', position: { x: 80, y: 200 }, data: {} },
            { id: 'end', type: 'end', name: '结束', position: { x: 640, y: 200 }, data: {} },
          ],
          edges: [{ id: 'e_start_end', source: 'start', target: 'end' }],
        },
      });
      setPage({ kind: 'editor', workflowId: created.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleRun(workflowId: string | null) {
    if (!workflowId) {
      setError('请先保存工作流再运行');
      return;
    }
    try {
      const { runId } = await runsApi.start(workflowId, null);
      setPage({ kind: 'runDetail', runId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleDelete(workflow: WorkflowRecord) {
    if (!window.confirm(`删除工作流「${workflow.name}」？此操作不可恢复。`)) return;
    try {
      await workflowsApi.remove(workflow.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-semibold">FlowAgent</h1>
        <nav className="flex gap-1 text-sm">
          <button
            type="button"
            onClick={() => setPage({ kind: 'workflows' })}
            className={`rounded px-3 py-1 ${page.kind === 'workflows' || page.kind === 'editor' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            工作流
          </button>
          <button
            type="button"
            onClick={() => setPage({ kind: 'mcp' })}
            className={`rounded px-3 py-1 ${page.kind === 'mcp' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            MCP Servers
          </button>
          <button
            type="button"
            onClick={() => setPage({ kind: 'runs' })}
            className={`rounded px-3 py-1 ${page.kind === 'runs' || page.kind === 'runDetail' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            运行
          </button>
        </nav>
        <span className="text-sm text-neutral-500">Durable Agent Runtime</span>
      </header>

      {page.kind === 'editor' ? (
        <main className="min-h-0 flex-1">
          <WorkflowEditorPage
            workflowId={page.workflowId}
            onBack={() => setPage({ kind: 'workflows' })}
            onRun={(workflowId) => void handleRun(workflowId)}
          />
        </main>
      ) : page.kind === 'runDetail' ? (
        <main className="min-h-0 flex-1">
          <RunDetailPage runId={page.runId} onBack={() => setPage({ kind: 'runs' })} />
        </main>
      ) : page.kind === 'runs' ? (
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <RunsPage onOpenRun={(runId) => setPage({ kind: 'runDetail', runId })} />
        </main>
      ) : page.kind === 'mcp' ? (
        <main className="flex-1 overflow-auto">
          <McpServersPage />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-600">工作流</h2>
            <button
              type="button"
              onClick={() => void handleCreate()}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
            >
              + 新建工作流
            </button>
          </div>
          {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          {workflows.length === 0 && !error && (
            <p className="text-sm text-neutral-400">暂无工作流，点击右上角新建</p>
          )}
          <ul className="space-y-2">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage({ kind: 'editor', workflowId: workflow.id })}
                  className="flex flex-1 items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-left transition-colors hover:border-neutral-400"
                >
                  <span className="text-sm font-medium">{workflow.name}</span>
                  <span className="text-xs text-neutral-400">v{workflow.version}</span>
                  <span className="ml-auto text-xs text-neutral-400">
                    {new Date(workflow.updatedAt).toLocaleString('zh-CN')}
                  </span>
                </button>
                <button
                  type="button"
                  title="删除工作流"
                  onClick={() => void handleDelete(workflow)}
                  className="rounded-lg border border-neutral-200 bg-white px-3 py-3 text-sm text-neutral-400 transition-colors hover:border-red-300 hover:text-red-600"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </main>
      )}
    </div>
  );
}
