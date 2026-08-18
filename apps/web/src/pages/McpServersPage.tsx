import { useCallback, useEffect, useMemo, useState } from 'react';

import { mcpApi, type McpServer, type McpTool } from '../api/mcp';

const STATUS_STYLES: Record<string, string> = {
  connected: 'bg-green-100 text-green-700',
  connecting: 'bg-yellow-100 text-yellow-700',
  error: 'bg-red-100 text-red-700',
  disconnected: 'bg-neutral-100 text-neutral-500',
};

const STATUS_LABELS: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  error: '错误',
  disconnected: '未连接',
};

export function McpServersPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('node');
  const [args, setArgs] = useState('');

  const [invokeTarget, setInvokeTarget] = useState<McpTool | null>(null);
  const [invokeArgs, setInvokeArgs] = useState('{}');
  const [invokeResult, setInvokeResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [serverList, toolList] = await Promise.all([mcpApi.listServers(), mcpApi.listTools()]);
      setServers(serverList);
      setTools(toolList);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toolsByServer = useMemo(() => {
    const map = new Map<string, McpTool[]>();
    for (const tool of tools) {
      const list = map.get(tool.serverId) ?? [];
      list.push(tool);
      map.set(tool.serverId, list);
    }
    return map;
  }, [tools]);

  async function handleCreate() {
    setBusy(true);
    try {
      await mcpApi.createServer({
        name: name.trim(),
        transport: 'stdio',
        command: command.trim(),
        args: args.trim() || undefined,
      });
      setName('');
      setArgs('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleAction(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleInvoke() {
    if (!invokeTarget) return;
    setBusy(true);
    setInvokeResult(null);
    try {
      const parsed = JSON.parse(invokeArgs) as Record<string, unknown>;
      const response = await mcpApi.invokeTool(invokeTarget.serverName, invokeTarget.name, parsed);
      setInvokeResult(JSON.stringify(response.result, null, 2));
    } catch (cause) {
      setInvokeResult(`调用失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-lg font-semibold">MCP Servers</h1>
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-600">添加 stdio Server</h2>
        <div className="grid grid-cols-[1fr_1fr_2fr_auto] gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="名称 (search)"
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="命令 (node)"
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <input
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder="参数（绝对路径，如 /abs/path/servers/search/dist/index.js）"
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={busy || name.trim().length === 0 || command.trim().length === 0}
            onClick={() => void handleCreate()}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            添加并连接
          </button>
        </div>
      </section>

      <section className="space-y-3">
        {servers.length === 0 && <p className="text-sm text-neutral-400">暂无 Server</p>}
        {servers.map((server) => (
          <article key={server.id} className="rounded-lg border border-neutral-200 bg-white p-4">
            <header className="flex items-center gap-3">
              <span className="font-mono text-sm font-semibold">{server.name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[server.status] ?? STATUS_STYLES.disconnected}`}
              >
                {STATUS_LABELS[server.status] ?? server.status}
              </span>
              <span className="text-xs text-neutral-400">
                {server.transport} · {server.toolCount} 工具
              </span>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleAction(() => mcpApi.reconnectServer(server.id))}
                  className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50"
                >
                  重连
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleAction(() => mcpApi.removeServer(server.id))}
                  className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  删除
                </button>
              </span>
            </header>
            {server.statusMessage && (
              <p className="mt-2 truncate text-xs text-red-500">{server.statusMessage}</p>
            )}
            <ul className="mt-3 space-y-1">
              {(toolsByServer.get(server.id) ?? []).map((tool) => (
                <li key={tool.qualifiedName} className="flex items-center gap-2 text-sm">
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">
                    {tool.qualifiedName}
                  </code>
                  <span className="truncate text-xs text-neutral-500">{tool.description}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setInvokeTarget(tool);
                      setInvokeArgs('{}');
                      setInvokeResult(null);
                    }}
                    className="ml-auto shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-50"
                  >
                    调用
                  </button>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      {invokeTarget && (
        <section className="fixed inset-0 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg space-y-3 rounded-lg bg-white p-4 shadow-lg">
            <h3 className="font-mono text-sm font-semibold">{invokeTarget.qualifiedName}</h3>
            <textarea
              value={invokeArgs}
              onChange={(event) => setInvokeArgs(event.target.value)}
              rows={4}
              className="w-full rounded border border-neutral-300 p-2 font-mono text-xs"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setInvokeTarget(null)}
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
              >
                关闭
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleInvoke()}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                调用
              </button>
            </div>
            {invokeResult && (
              <pre className="max-h-60 overflow-auto rounded bg-neutral-50 p-2 text-xs">
                {invokeResult}
              </pre>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
