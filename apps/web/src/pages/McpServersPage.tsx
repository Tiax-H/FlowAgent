import { useCallback, useEffect, useMemo, useState } from 'react';

import { mcpApi, type McpServer, type McpTool } from '../api/mcp';
import { Button, CopyButton, EmptyState, LoadingRows, Modal } from '../components/ui';

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

/** 从工具的 inputSchema 提取人类可读的参数提示（属性名: 类型，必填标 *） */
function describeInputSchema(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object' || !record.properties || typeof record.properties !== 'object') {
    return null;
  }
  const required =
    Array.isArray(record.required) &&
    record.required.every((item) => typeof item === 'string')
      ? (record.required as string[])
      : [];
  const lines = Object.entries(record.properties as Record<string, unknown>).map(([name, raw]) => {
    const type = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).type === 'string'
      ? ((raw as Record<string, unknown>).type as string)
      : 'any';
    const description =
      raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).description === 'string'
        ? ` ${(raw as Record<string, unknown>).description as string}`
        : '';
    return `${required.includes(name) ? '*' : ''}${name}: ${type} —${description}`;
  });
  return lines.length > 0 ? lines.join('\n') : null;
}

export function McpServersPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('node');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  /** 展开查看完整连接错误信息的 server id 集合 */
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  const [invokeTarget, setInvokeTarget] = useState<McpTool | null>(null);
  const [invokeArgs, setInvokeArgs] = useState('{}');
  const [invokeResult, setInvokeResult] = useState<string | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [serverList, toolList] = await Promise.all([mcpApi.listServers(), mcpApi.listTools()]);
      setServers(serverList);
      setTools(toolList);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
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
      await mcpApi.createServer(
        transport === 'stdio'
          ? {
              name: name.trim(),
              transport,
              command: command.trim(),
              args: args.trim() || undefined,
            }
          : { name: name.trim(), transport, url: url.trim() },
      );
      setName('');
      setArgs('');
      setUrl('');
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
    setInvokeError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(invokeArgs) as Record<string, unknown>;
    } catch (cause) {
      setInvokeError(`参数不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
      setBusy(false);
      return;
    }
    try {
      const response = await mcpApi.invokeTool(invokeTarget.serverName, invokeTarget.name, parsed);
      setInvokeResult(JSON.stringify(response.result, null, 2));
    } catch (cause) {
      setInvokeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">MCP Servers</h1>
        <Button
          variant="secondary"
          disabled={busy}
          title="重新拉取 Server 连接状态与工具注册表"
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-600">添加 Server</h2>
        <div className="mb-3 flex gap-1">
          {(['stdio', 'http'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTransport(option)}
              className={`rounded px-3 py-1 text-sm ${transport === option ? 'bg-neutral-900 text-white' : 'border border-neutral-300 text-neutral-600 hover:bg-neutral-50'}`}
            >
              {option === 'stdio' ? 'stdio（本地进程）' : 'Streamable HTTP（远程）'}
            </button>
          ))}
        </div>
        {transport === 'stdio' ? (
          <div>
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
                placeholder="Server 脚本的绝对路径（空格分隔多个参数）"
                className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
              />
              <Button variant="primary" disabled={busy || name.trim().length === 0 || command.trim().length === 0} onClick={() => void handleCreate()}>
                {busy ? '连接中…' : '添加并连接'}
              </Button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-400">
              参数必须是<b>绝对路径</b>（stdio 子进程按 server 进程的工作目录解析相对路径）。项目自带的 demo Server 位于仓库根目录下
              <code className="mx-1 rounded bg-neutral-100 px-1">servers/search</code>
              <code className="mx-1 rounded bg-neutral-100 px-1">servers/sandbox</code>
              <code className="mx-1 rounded bg-neutral-100 px-1">servers/report</code>
              ，构建后取各自的 <code className="rounded bg-neutral-100 px-1">dist/index.js</code>
              ，前面拼上你本仓库的绝对路径即可。示例（复制后把 {'<仓库绝对路径>'} 替换成实际路径）：
              <CopyButton
                text="node <仓库绝对路径>/servers/search/dist/index.js"
                label="复制 search 示例"
              />
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_2fr_auto] gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="名称 (remote-search)"
              className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="MCP 端点 (http://localhost:3100/mcp)"
              className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <Button variant="primary" disabled={busy || name.trim().length === 0 || url.trim().length === 0} onClick={() => void handleCreate()}>
              {busy ? '连接中…' : '添加并连接'}
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        {!loaded && servers.length === 0 && <LoadingRows rows={2} />}
        {loaded && servers.length === 0 && (
          <EmptyState
            title="还没有注册任何 MCP Server"
            description={
              <>
                MCP Server 提供工作流可调用的工具（搜索、代码执行、报告生成等）。
                先在上方添加一个，或复制示例命令体验自带的 demo Server。
                没有 Server 也可以先创建纯 LLM 工作流。
              </>
            }
          />
        )}
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
                  onClick={() => {
                    if (
                      window.confirm(
                        `删除 MCP Server「${server.name}」？引用其工具的节点将无法运行，此操作不可恢复。`,
                      )
                    ) {
                      void handleAction(() => mcpApi.removeServer(server.id));
                    }
                  }}
                  className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  删除
                </button>
              </span>
            </header>
            {server.statusMessage && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedErrors((previous) => {
                      const next = new Set(previous);
                      if (next.has(server.id)) next.delete(server.id);
                      else next.add(server.id);
                      return next;
                    })
                  }
                  className={`text-left text-xs text-red-500 ${expandedErrors.has(server.id) ? '' : 'truncate block max-w-full'}`}
                >
                  {expandedErrors.has(server.id)
                    ? server.statusMessage
                    : server.statusMessage.slice(0, 120)}
                  {(server.statusMessage.length > 120 || expandedErrors.has(server.id)) && (
                    <span className="ml-1 text-neutral-400">
                      {expandedErrors.has(server.id) ? '[收起]' : '…[展开]'}
                    </span>
                  )}
                </button>
              </div>
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
        <Modal title={<code>{invokeTarget.qualifiedName}</code>} onClose={() => setInvokeTarget(null)} width="w-[36rem]">
          {(() => {
            const hint = describeInputSchema(invokeTarget.inputSchema);
            return hint ? (
              <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                {`参数说明（* 为必填）：\n${hint}`}
              </pre>
            ) : (
              <p className="mb-2 text-xs text-neutral-400">该工具未提供参数说明，请参考其文档填写 JSON 对象。</p>
            );
          })()}
          <textarea
            value={invokeArgs}
            onChange={(event) => setInvokeArgs(event.target.value)}
            rows={4}
            placeholder='{ "query": "durable execution" }'
            className="w-full rounded border border-neutral-300 p-2 font-mono text-xs focus:border-neutral-500 focus:outline-none"
          />
          {invokeError && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600">
              {invokeError}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <CopyButton text={invokeArgs} label="复制参数" />
            {invokeResult && <CopyButton text={invokeResult} label="复制结果" />}
            <span className="flex-1" />
            <Button variant="secondary" onClick={() => setInvokeTarget(null)}>
              关闭
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void handleInvoke()}>
              {busy ? '调用中…' : '调用'}
            </Button>
          </div>
          {invokeResult && (
            <pre className="mt-3 max-h-60 overflow-auto rounded bg-neutral-50 p-2 text-xs">
              {invokeResult}
            </pre>
          )}
        </Modal>
      )}
    </div>
  );
}
