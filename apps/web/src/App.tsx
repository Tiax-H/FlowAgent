import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { mcpApi } from './api/mcp';
import { providersApi } from './api/providers';
import { runsApi } from './api/runs';
import { workflowsApi } from './api/workflows';
import { Button, LoadingRows, Modal } from './components/ui';
import { SettingsPage } from './pages/SettingsPage';
import { McpServersPage } from './pages/McpServersPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { WorkflowEditorPage } from './pages/WorkflowEditorPage';
import { buildInputSkeleton, collectInputFieldNames } from './lib/inputSkeleton';
import type { WorkflowDefinition, WorkflowRecord } from './workflow/types';

/** 输入字段的展示类型：长文本字段渲染为多行编辑框 */
type FieldKind = 'text' | 'longText' | 'number' | 'boolean';
interface InputField {
  name: string;
  kind: FieldKind;
  description?: string;
  required: boolean;
}

const LONG_TEXT_HINT = /diff|code|text|content|prompt|script|body|json/i;

/** 后端 JSON body 上限：运行输入超限时本地直接拦截，不发请求 */
const MAX_INPUT_BYTES = 1024 * 1024;

function parseHash(hash: string): Route {
  const segments = hash.replace(/^#/, '').split('/').filter(Boolean);
  switch (segments[0]) {
    case 'mcp':
      return { kind: 'mcp' };
    case 'settings':
      return { kind: 'settings' };
    case 'runs':
      return segments[1] ? { kind: 'run', id: segments[1] } : { kind: 'runs' };
    case 'editor':
      return { kind: 'editor', workflowId: segments[1] ?? null };
    default:
      return { kind: 'workflows' };
  }
}

type Route =
  | { kind: 'workflows' }
  | { kind: 'mcp' }
  | { kind: 'runs' }
  | { kind: 'settings' }
  | { kind: 'editor'; workflowId: string | null }
  | { kind: 'run'; id: string };

function go(path: string): void {
  window.location.hash = path;
}

/** Route → hash 串（路由被守卫取消时回滚地址栏用） */
function routeToHash(route: Route): string {
  switch (route.kind) {
    case 'mcp':
      return '#/mcp';
    case 'settings':
      return '#/settings';
    case 'runs':
      return '#/runs';
    case 'editor':
      return route.workflowId ? `#/editor/${route.workflowId}` : '#/editor';
    case 'run':
      return `#/runs/${route.id}`;
    default:
      return '#/workflows';
  }
}

function routesEqual(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'editor' && b.kind === 'editor') return a.workflowId === b.workflowId;
  if (a.kind === 'run' && b.kind === 'run') return a.id === b.id;
  return true;
}

/** 从 start 节点 inputSchema 提取表单字段；无 schema 时回退到模板引用分析 */
function extractInputFields(definition: WorkflowDefinition): InputField[] {
  const start = definition.nodes.find((node) => node.type === 'start');
  const schema = (start?.data as { inputSchema?: unknown } | undefined)?.inputSchema;
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>;
    if (record.type === 'object' && record.properties && typeof record.properties === 'object') {
      const required = Array.isArray(record.required)
        ? record.required.filter((item): item is string => typeof item === 'string')
        : [];
      return Object.entries(record.properties as Record<string, unknown>).map(([name, raw]) => {
        const field = (raw && typeof raw === 'object' ? raw : {}) as {
          type?: unknown;
          description?: unknown;
        };
        const type = typeof field.type === 'string' ? field.type : 'string';
        const description = typeof field.description === 'string' ? field.description : undefined;
        const kind: FieldKind =
          type === 'number' || type === 'integer'
            ? 'number'
            : type === 'boolean'
              ? 'boolean'
              : LONG_TEXT_HINT.test(name) || (description?.length ?? 0) > 60
                ? 'longText'
                : 'text';
        return { name, kind, description, required: required.includes(name) };
      });
    }
  }
  // 无 schema：按提示词/模板里的 {{input.xxx}} 引用生成字段（解决"不知道填什么"）
  return collectInputFieldNames(definition).map((name) => ({
    name,
    kind: LONG_TEXT_HINT.test(name) ? ('longText' as const) : ('text' as const),
    required: false,
  }));
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  /** 编辑器 dirty 状态的镜像：hashchange 无法取消，守卫要在切路由前同步判断 */
  const editorDirtyRef = useRef(false);
  const handleEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
  }, []);

  // 路由切换守卫：画布有未保存修改时先确认；取消则回滚地址栏。
  // 顶部导航、编辑器「← 返回」、浏览器前进/后退统一走这一个入口，避免重复弹窗。
  const routeRef = useRef(route);
  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash(window.location.hash);
      const current = routeRef.current;
      if (routesEqual(current, next)) return;
      if (current.kind === 'editor' && editorDirtyRef.current) {
        if (!window.confirm('画布有未保存修改，确定离开？')) {
          window.location.hash = routeToHash(current);
          return;
        }
      }
      if (next.kind !== 'editor') {
        // 离开编辑器：重置 dirty 镜像（编辑器组件随即卸载）
        editorDirtyRef.current = false;
      }
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 全局错误横幅是否展开显示全文（默认单行截断） */
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 工作流搜索：输入即时、查询防抖 300ms */
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  /** 前端按名称过滤（后端 ?search= 未上线时的兜底；后端已过滤时为幂等操作） */
  const filterByName = useCallback((items: WorkflowRecord[], keyword: string) => {
    const query = keyword.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => item.name.toLowerCase().includes(query));
  }, []);

  const refresh = useCallback(async () => {
    const keyword = searchQuery;
    try {
      setWorkflows(filterByName(await workflowsApi.list(keyword || undefined), keyword));
      setError(null);
    } catch (cause) {
      if (keyword) {
        // 老后端不识别 ?search= 时退化为全量拉取 + 前端过滤
        try {
          setWorkflows(filterByName(await workflowsApi.list(), keyword));
          setError(null);
          return;
        } catch {
          /* 走统一错误提示 */
        }
      }
      setError(
        cause instanceof TypeError ? '无法连接服务器，请确认 server 已启动' : String(cause),
      );
    } finally {
      setListLoading(false);
    }
  }, [searchQuery, filterByName]);

  /** Provider/MCP 就绪状态：用于引导与运行前提醒 */
  const [providerCount, setProviderCount] = useState<number | null>(null);
  const [serverCount, setServerCount] = useState<number | null>(null);

  /** 待确认启动的运行（弹出输入对话框） */
  const [runPrompt, setRunPrompt] = useState<{ workflowId: string; name: string } | null>(null);

  useEffect(() => {
    if (route.kind === 'workflows') void refresh();
  }, [route.kind, refresh]);

  useEffect(() => {
    void providersApi
      .list()
      .then(({ providers }) => setProviderCount(providers.length))
      .catch(() => setProviderCount(0));
    void mcpApi
      .listServers()
      .then((servers) => setServerCount(servers.filter((item) => item.status === 'connected').length))
      .catch(() => setServerCount(0));
  }, []);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      // 默认名带时间（MM-DD HH:mm），避免同一天多次新建全部重名
      const now = new Date();
      const pad = (value: number): string => String(value).padStart(2, '0');
      const created = await workflowsApi.create({
        name: `工作流 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
        definition: {
          schemaVersion: 1,
          nodes: [
            { id: 'start', type: 'start', name: '开始', position: { x: 80, y: 200 }, data: {} },
            { id: 'end', type: 'end', name: '结束', position: { x: 640, y: 200 }, data: {} },
          ],
          edges: [{ id: 'e_start_end', source: 'start', target: 'end' }],
        },
      });
      go(`/editor/${created.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  /** 发起运行：打开输入对话框，加载工作流定义以生成输入表单 */
  function handleRun(workflowId: string | null) {
    if (!workflowId) {
      setError('请先保存工作流再运行');
      return;
    }
    const workflow = workflows.find((item) => item.id === workflowId);
    setRunPrompt({ workflowId, name: workflow?.name ?? workflowId });
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

  const navItems: Array<{ label: string; path: string; active: boolean }> = [
    {
      label: '工作流',
      path: '/workflows',
      active: route.kind === 'workflows' || route.kind === 'editor',
    },
    { label: 'MCP Servers', path: '/mcp', active: route.kind === 'mcp' },
    { label: '运行', path: '/runs', active: route.kind === 'runs' || route.kind === 'run' },
    { label: '设置', path: '/settings', active: route.kind === 'settings' },
  ];

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <button
          type="button"
          onClick={() => go('/workflows')}
          className="flex items-baseline gap-2 text-left"
        >
          <h1 className="text-lg font-semibold">FlowAgent</h1>
          <span className="hidden text-xs text-neutral-400 sm:inline">Durable Agent Runtime</span>
        </button>
        <nav className="flex gap-1 text-sm">
          {navItems.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => go(item.path)}
              className={`rounded px-3 py-1 transition-colors ${
                item.active
                  ? 'bg-neutral-900 text-white'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {/* 全局错误横幅：任何页面的失败都可见；默认单行截断，可展开看全文 */}
      {error && (
        <p className="flex items-start gap-2 bg-red-50 px-4 py-2 text-sm text-red-600">
          <span
            className={`min-w-0 flex-1 ${
              errorExpanded ? 'break-all whitespace-pre-wrap' : 'truncate'
            }`}
          >
            {error}
          </span>
          <button
            type="button"
            onClick={() => setErrorExpanded((value) => !value)}
            className="shrink-0 rounded px-1 text-xs text-red-500 hover:bg-red-100"
          >
            {errorExpanded ? '收起' : '展开'}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setErrorExpanded(false);
            }}
            className="shrink-0 rounded px-1 text-xs text-red-400 hover:bg-red-100"
          >
            关闭
          </button>
        </p>
      )}

      {/* 编辑器内：未配置 Provider 的常驻提醒 */}
      {route.kind === 'editor' && providerCount === 0 && (
        <div className="flex items-center gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <span>尚未配置任何 LLM Provider，LLM / Agent 节点将无法运行。</span>
          <Button variant="secondary" onClick={() => go('/settings')}>
            查看配置方法
          </Button>
        </div>
      )}

      {route.kind === 'editor' ? (
        <main className="min-h-0 flex-1">
          <WorkflowEditorPage
            workflowId={route.workflowId}
            onBack={() => go('/workflows')}
            onRun={(workflowId) => handleRun(workflowId)}
            onDirtyChange={handleEditorDirtyChange}
          />
        </main>
      ) : route.kind === 'run' ? (
        <main className="min-h-0 flex-1">
          <RunDetailPage runId={route.id} onBack={() => go('/runs')} />
        </main>
      ) : route.kind === 'runs' ? (
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <RunsPage
            onOpenRun={(runId) => go(`/runs/${runId}`)}
            onGoWorkflows={() => go('/workflows')}
          />
        </main>
      ) : route.kind === 'mcp' ? (
        <main className="flex-1 overflow-auto">
          <McpServersPage />
        </main>
      ) : route.kind === 'settings' ? (
        <main className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-6">
          <SettingsPage
            onGoMcp={() => go('/mcp')}
            onGoWorkflows={() => go('/workflows')}
          />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-neutral-600">工作流</h2>
              <p className="mt-0.5 text-xs text-neutral-400">
                编排 LLM 与 MCP 工具的持久化执行流程；运行记录见「运行」页
              </p>
            </div>
            <Button variant="primary" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? '创建中…' : '+ 新建工作流'}
            </Button>
          </div>

          {/* 名称搜索：300ms 防抖，后端 ?search= 未上线时由前端过滤兜底 */}
          <div className="mb-4">
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索工作流名称…"
              className="w-full max-w-xs rounded border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
            />
          </div>

          {/* 首次使用三步引导 */}
          {(providerCount === 0 || serverCount === 0 || (workflows.length === 0 && !listLoading)) && (
            <ol className="mb-4 space-y-1 rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-sm text-neutral-700">
              <li className="font-medium text-blue-800">第一次使用？按顺序完成三步：</li>
              {[
                {
                  done: (providerCount ?? 0) > 0,
                  step: '① 配置 LLM Provider（API Key）',
                  desc: '在设置页按指引填写 .env 并重启服务',
                  action: () => go('/settings'),
                  actionLabel: '去设置',
                },
                {
                  done: (serverCount ?? 0) > 0,
                  step: '② 注册 MCP Server（可选，工具节点需要）',
                  desc: '例如自带的 search / sandbox / report demo Server',
                  action: () => go('/mcp'),
                  actionLabel: '去注册',
                },
                {
                  done: workflows.length > 0,
                  step: '③ 新建或导入工作流并运行',
                  desc: '画布上拖入节点连线，点 ▶ 运行',
                  action: () => void handleCreate(),
                  actionLabel: '新建工作流',
                },
              ].map((item) => (
                <li key={item.step} className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                      item.done ? 'bg-emerald-500' : 'bg-neutral-300'
                    }`}
                    aria-hidden
                  />
                  <span className={item.done ? 'text-neutral-400 line-through' : 'font-medium'}>
                    {item.step}
                  </span>
                  {!item.done && (
                    <>
                      <span className="hidden truncate text-xs text-neutral-500 md:inline">
                        {item.desc}
                      </span>
                      <button
                        type="button"
                        onClick={item.action}
                        className="ml-auto shrink-0 rounded border border-blue-300 bg-white px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-100"
                      >
                        {item.actionLabel}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}

          {listLoading ? (
            <LoadingRows rows={3} />
          ) : workflows.length === 0 && !error ? (
            <p className="text-sm text-neutral-400">
              {searchQuery ? '没有匹配的工作流' : '暂无工作流'}
            </p>
          ) : (
            <ul className="space-y-2">
              {workflows.map((workflow) => (
                <li key={workflow.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => go(`/editor/${workflow.id}`)}
                    className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-left transition-colors hover:border-neutral-400"
                  >
                    <span className="min-w-0 truncate text-sm font-medium group-hover:text-blue-700">
                      {workflow.name}
                    </span>
                    <span className="text-xs text-neutral-400">v{workflow.version}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span
                        className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden
                      >
                        打开编辑器 ▸
                      </span>
                      <span className="text-xs text-neutral-400">
                        {new Date(workflow.updatedAt).toLocaleString('zh-CN')}
                      </span>
                    </span>
                  </button>
                  <Button variant="accent" onClick={() => handleRun(workflow.id)}>
                    ▶ 运行
                  </Button>
                  <Button
                    variant="dangerOutline"
                    title="删除工作流"
                    onClick={() => void handleDelete(workflow)}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </main>
      )}

      {runPrompt && (
        <RunInputDialog
          workflowId={runPrompt.workflowId}
          name={runPrompt.name}
          onClose={() => setRunPrompt(null)}
          onStarted={(runId) => {
            setRunPrompt(null);
            setError(null);
            go(`/runs/${runId}`);
          }}
        />
      )}
    </div>
  );
}

/** 运行输入对话框：优先按 start.inputSchema / {{input.*}} 引用生成表单，可切换 JSON 模式 */
function RunInputDialog({
  workflowId,
  name,
  onClose,
  onStarted,
}: {
  workflowId: string;
  name: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [fields, setFields] = useState<InputField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [jsonText, setJsonText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const record = await workflowsApi.get(workflowId);
        if (cancelled) return;
        if (!record.definition) {
          setLoadFailed(true);
          return;
        }
        setDefinition(record.definition);
        const extracted = extractInputFields(record.definition);
        setFields(extracted);
        setValues(Object.fromEntries(extracted.map((field) => [field.name, ''])));
        if (extracted.length === 0) setMode('json');
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  const jsonSkeleton = useMemo(() => {
    if (!definition) return '';
    const skeleton = buildInputSkeleton(definition);
    return Object.keys(skeleton).length > 0 ? JSON.stringify(skeleton, null, 2) : '{ }';
  }, [definition]);

  async function submit(): Promise<void> {
    if (submitting) return;
    let input: unknown = null;
    if (mode === 'form') {
      input = Object.fromEntries(
        fields.flatMap((field): Array<[string, unknown]> => {
          const raw = values[field.name]?.trim() ?? '';
          if (field.kind === 'boolean') {
            // 三态：不传 = 省略字段，不产出 null/false 误导下游判断
            if (raw === '') return [];
            return [[field.name, raw === 'true']];
          }
          if (field.kind === 'number') return [[field.name, raw === '' ? null : Number(raw)]];
          return [[field.name, raw === '' ? null : raw]];
        }),
      );
    } else {
      const trimmed = jsonText.trim();
      if (trimmed.length > 0) {
        try {
          input = JSON.parse(trimmed) as unknown;
        } catch (cause) {
          setInlineError(`不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        // JSON 模式提交前预检体积：超过后端 1MB 上限直接拦截，不发请求
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_INPUT_BYTES) {
          setInlineError('输入内容超过 1MB 上限，请精简后重试');
          return;
        }
      }
    }
    const missing = fields.filter((field) => {
      const raw = values[field.name];
      return field.required && (raw == null || raw.trim() === '');
    });
    if (missing.length > 0) {
      setInlineError(`必填项未填写：${missing.map((field) => field.name).join('、')}`);
      return;
    }
    setSubmitting(true);
    setInlineError(null);
    try {
      const { runId } = await runsApi.start(workflowId, input);
      onStarted(runId);
    } catch (cause) {
      setInlineError(
        cause instanceof TypeError ? '无法连接服务器，请确认 server 已启动' : String(cause),
      );
      setSubmitting(false);
    }
  }

  return (
    <Modal title={<span>运行「{name}」</span>} onClose={onClose} width="w-[34rem]">
      {loadFailed ? (
        <p className="mt-3 text-xs text-amber-600">
          无法读取工作流定义（可能尚未保存），可直接在 JSON 模式下输入。
        </p>
      ) : definition === null ? (
        <p className="mt-3 text-xs text-neutral-400">正在读取工作流定义…</p>
      ) : (
        <div className="mt-2">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="text-neutral-500">输入方式：</span>
            {(['form', 'json'] as const).map((item) => (
              <button
                key={item}
                type="button"
                disabled={fields.length === 0 && item === 'form'}
                onClick={() => setMode(item)}
                className={`rounded px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  mode === item
                    ? 'bg-neutral-900 text-white'
                    : 'border border-neutral-300 text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {item === 'form' ? `表单${fields.length > 0 ? `（${fields.length} 项）` : ''}` : 'JSON'}
              </button>
            ))}
          </div>

          {mode === 'form' ? (
            <div className="max-h-[45vh] space-y-3 overflow-auto pr-1">
              {fields.map((field) => (
                <label key={field.name} className="block">
                  <span className="text-xs font-medium text-neutral-700">
                    {field.name}
                    {field.required && <span className="ml-0.5 text-red-500">*</span>}
                    <span className="ml-2 font-normal text-neutral-400">
                      以 {'{{input.' + field.name + '}}'} 在节点中引用
                    </span>
                  </span>
                  {field.kind === 'longText' ? (
                    <textarea
                      value={values[field.name] ?? ''}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.name]: event.target.value }))
                      }
                      rows={6}
                      placeholder={
                        field.name === 'diff'
                          ? '粘贴要审查的代码 diff，例如：\n--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,3 @@\n+eval(userInput)'
                          : field.description ?? `填写 ${field.name}`
                      }
                      className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
                    />
                  ) : field.kind === 'boolean' ? (
                    <select
                      value={values[field.name] ?? ''}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.name]: event.target.value }))
                      }
                      className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
                    >
                      <option value="">不传（保持未设置）</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={field.kind === 'number' ? 'number' : 'text'}
                      value={values[field.name] ?? ''}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.name]: event.target.value }))
                      }
                      placeholder={field.description ?? `填写 ${field.name}`}
                      className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
                    />
                  )}
                  {field.description && field.kind !== 'longText' && (
                    <span className="mt-0.5 block text-xs text-neutral-400">{field.description}</span>
                  )}
                </label>
              ))}
              <p className="text-xs leading-relaxed text-neutral-400">
                这些字段来自工作流的模板引用与输入定义。复杂嵌套结构请切换到 JSON 模式。
              </p>
            </div>
          ) : (
            <div>
              <textarea
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                placeholder={`${jsonSkeleton}\n// 工作流内以 {{input.xxx}} 引用这些字段`}
                rows={8}
                className="w-full rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-neutral-400">
                可留空。骨架中的字段名来自该工作流的模板引用，按需填值。
              </p>
            </div>
          )}
        </div>
      )}

      {inlineError && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600">
          {inlineError}
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button variant="accent" disabled={submitting || (!loadFailed && definition === null)} onClick={() => void submit()}>
          {submitting ? '启动中…' : '启动运行'}
        </Button>
      </div>
    </Modal>
  );
}
