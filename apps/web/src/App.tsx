import { useEffect, useState } from 'react';

import { McpServersPage } from './pages/McpServersPage';
import type { WorkflowSummary } from './types';

type Page = 'workflows' | 'mcp';

export function App() {
  const [page, setPage] = useState<Page>('workflows');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (page !== 'workflows') return;
    fetch('/api/workflows')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<WorkflowSummary[]>;
      })
      .then(setWorkflows)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [page]);

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-semibold">FlowAgent</h1>
        <nav className="flex gap-1 text-sm">
          <button
            type="button"
            onClick={() => setPage('workflows')}
            className={`rounded px-3 py-1 ${page === 'workflows' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            工作流
          </button>
          <button
            type="button"
            onClick={() => setPage('mcp')}
            className={`rounded px-3 py-1 ${page === 'mcp' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            MCP Servers
          </button>
        </nav>
        <span className="text-sm text-neutral-500">Durable Agent Runtime</span>
      </header>
      {page === 'mcp' ? (
        <main className="flex-1 overflow-auto">
          <McpServersPage />
        </main>
      ) : (
        <main className="flex flex-1 flex-col overflow-hidden">
          <section className="flex-1 p-6">
            <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-neutral-400">
              工作流画布（第 4-5 周接入 @xyflow/react）
            </div>
          </section>
          <aside className="max-h-64 overflow-auto border-t border-neutral-200 bg-white px-6 py-4">
            <h2 className="mb-2 text-sm font-medium text-neutral-600">已保存的工作流</h2>
            {error && <p className="text-sm text-red-500">加载失败：{error}</p>}
            {!error && workflows.length === 0 && (
              <p className="text-sm text-neutral-400">暂无工作流</p>
            )}
            <ul className="space-y-1">
              {workflows.map((workflow) => (
                <li key={workflow.id} className="text-sm text-neutral-700">
                  {workflow.name}
                  <span className="ml-2 text-xs text-neutral-400">v{workflow.version}</span>
                </li>
              ))}
            </ul>
          </aside>
        </main>
      )}
    </div>
  );
}
