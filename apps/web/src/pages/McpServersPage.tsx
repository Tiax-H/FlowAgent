import { useCallback, useEffect, useMemo, useState } from 'react';

import { mcpApi, type McpServer, type McpTool } from '../api/mcp';
import { RefreshIcon } from '../components/icons';
import {
  Button,
  confirmDialog,
  CopyButton,
  EmptyState,
  LoadingRows,
  Modal,
  StatusBadge,
} from '../components/ui';
import type { StatusTone } from '../components/ui';

const STATUS_TONES: Record<string, StatusTone> = {
  connected: 'success',
  connecting: 'warning',
  error: 'danger',
  disconnected: 'neutral',
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
      {error && (
        <p className="rounded-md border border-danger-6 bg-danger-2 px-3 py-2 text-sm text-danger-11">
          {error}
        </p>
      )}

      <section className="rounded-lg border border-border-soft bg-card p-4">
        <h2 className="mb-3 text-sm font-medium text-foreground">添加 Server</h2>
        <div className="mb-3">
          <div className="inline-flex rounded-md bg-muted-strong p-0.5">
            {(['stdio', 'http'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTransport(option)}
                className={`rounded-[5px] px-3 py-1 text-sm transition-colors ${
                  transport === option
                    ? 'bg-card font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option === 'stdio' ? 'stdio（本地进程）' : 'Streamable HTTP（远程）'}
              </button>
            ))}
          </div>
        </div>
        {transport === 'stdio' ? (
          <div>
            <div className="grid grid-cols-[1fr_1fr_2fr_auto] items-center gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="名称 (search)"
                className="h-8 rounded-md border border-input bg-card px-2.5 text-sm"
              />
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="命令 (node)"
                className="h-8 rounded-md border border-input bg-card px-2.5 text-sm"
              />
              <input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder="绝对路径（空格分隔参数）"
                className="h-8 rounded-md border border-input bg-card px-2.5 text-sm"
              />
              <Button variant="primary" disabled={busy || name.trim().length === 0 || command.trim().length === 0} onClick={() => void handleCreate()}>
                {busy ? '连接中…' : '添加并连接'}
              </Button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-faint">
              参数必须是<b>绝对路径</b>（stdio 子进程按 server 进程的工作目录解析相对路径）。项目自带的 demo Server 位于仓库根目录下
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-2xs text-sand-11">servers/search</code>
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-2xs text-sand-11">servers/sandbox</code>
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-2xs text-sand-11">servers/report</code>
              ，构建后取各自的 <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs text-sand-11">dist/index.js</code>
              ，前面拼上你本仓库的绝对路径即可。示例（复制后把 {'<仓库绝对路径>'} 替换成实际路径）：
              <CopyButton
                text="node <仓库绝对路径>/servers/search/dist/index.js"
                label="复制 search 示例"
              />
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="名称 (remote-search)"
              className="h-8 rounded-md border border-input bg-card px-2.5 text-sm"
            />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="MCP 端点 (http://localhost:3100/mcp)"
              className="h-8 rounded-md border border-input bg-card px-2.5 text-sm"
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
          <article key={server.id} className="rounded-lg border border-border-soft bg-card p-4">
            <header className="flex items-center gap-3">
              <span className="font-mono text-sm font-medium">{server.name}</span>
              <StatusBadge
                label={STATUS_LABELS[server.status] ?? server.status}
                tone={STATUS_TONES[server.status] ?? 'neutral'}
              />
              <span className="text-xs text-faint">
                {server.transport} · {server.toolCount} 工具
              </span>
              <span className="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleAction(() => mcpApi.reconnectServer(server.id))}
                >
                  <RefreshIcon />
                  重连
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void confirmDialog({
                      title: `删除 MCP Server「${server.name}」？`,
                      description: '引用其工具的节点将无法运行，此操作不可恢复。',
                      confirmLabel: '删除',
                      danger: true,
                    }).then((confirmed) => {
                      if (confirmed) void handleAction(() => mcpApi.removeServer(server.id));
                    });
                  }}
                >
                  删除
                </Button>
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
                  className={`text-left text-xs text-danger-11 ${expandedErrors.has(server.id) ? '' : 'truncate block max-w-full'}`}
                >
                  {expandedErrors.has(server.id)
                    ? server.statusMessage
                    : server.statusMessage.slice(0, 120)}
                  {(server.statusMessage.length > 120 || expandedErrors.has(server.id)) && (
                    <span className="ml-1 text-faint">
                      {expandedErrors.has(server.id) ? '[收起]' : '…[展开]'}
                    </span>
                  )}
                </button>
              </div>
            )}
            <ul className="mt-3 space-y-1">
              {(toolsByServer.get(server.id) ?? []).map((tool) => (
                <li key={tool.qualifiedName} className="flex items-center gap-2 text-sm">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-sand-11">
                    {tool.qualifiedName}
                  </code>
                  <span className="truncate text-xs text-muted-foreground">{tool.description}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto shrink-0"
                    onClick={() => {
                      setInvokeTarget(tool);
                      setInvokeArgs('{}');
                      setInvokeResult(null);
                    }}
                  >
                    调用
                  </Button>
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
              <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
                {`参数说明（* 为必填）：\n${hint}`}
              </pre>
            ) : (
              <p className="mb-2 text-xs text-faint">该工具未提供参数说明，请参考其文档填写 JSON 对象。</p>
            );
          })()}
          <textarea
            value={invokeArgs}
            onChange={(event) => setInvokeArgs(event.target.value)}
            rows={4}
            placeholder='{ "query": "durable execution" }'
            className="min-h-8 w-full rounded-md border border-input bg-card px-2.5 py-1.5 font-mono text-sm"
          />
          {invokeError && (
            <p className="mt-2 rounded-md border border-danger-6 bg-danger-2 px-2.5 py-1.5 text-xs text-danger-11">
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
            <pre className="mt-3 max-h-60 overflow-auto rounded-md border border-border-soft bg-muted p-2.5 font-mono text-2xs leading-relaxed">
              {invokeResult}
            </pre>
          )}
        </Modal>
      )}
    </div>
  );
}
