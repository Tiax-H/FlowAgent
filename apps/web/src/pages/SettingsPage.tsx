import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import {
  providersApi,
  type ProviderInfo,
  type ProviderSource,
  type ProviderUpdatePayload,
} from '../api/providers';
import { CheckIcon, PlusIcon, XIcon } from '../components/icons';
import { Button, confirmDialog, CopyButton, LoadingRows, Modal } from '../components/ui';

/** 设置页可选导航回调：传入才渲染对应跳转按钮（导航接线由 App 层完成） */
export interface SettingsPageProps {
  /** 跳转到 MCP Servers 页 */
  onGoMcp?: () => void;
  /** 跳转到工作流列表页 */
  onGoWorkflows?: () => void;
}

/** 零配置引导卡中的可复制 .env 模板（命名规则见 apps/server/src/llm/llm.adapter.ts） */
const ENV_TEMPLATE = [
  '# .env（仓库根目录）',
  'FLOWAGENT_PROVIDERS_OPENAI__BASEURL=https://api.openai.com/v1',
  'FLOWAGENT_PROVIDERS_OPENAI__APIKEY=sk-你的密钥',
  'FLOWAGENT_PROVIDERS_OPENAI__MODELS=gpt-4o,gpt-4o-mini',
].join('\n');

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; providers: ProviderInfo[]; configurable?: boolean }
  | { phase: 'error'; message: string };

/** 操作结果轻提示：ok 数秒后自动消失，error 需手动关闭（失败原因必须停留） */
type Notice = { kind: 'ok' | 'error'; text: string } | null;

/** 零配置时的琥珀色引导卡：分步说明 + 可复制 .env 模板 */
function ZeroConfigGuide({ webConfigAvailable = false }: { webConfigAvailable?: boolean }) {
  return (
    <div className="rounded-lg border border-warning-6 bg-warning-2 p-4">
      <h3 className="text-sm font-semibold text-warning-12">尚未配置任何 LLM Provider</h3>
      <ol className="mt-2 space-y-1.5 text-sm leading-relaxed text-warning-12">
        <li>
          ① 在仓库根目录创建/编辑 <code className="font-mono">.env</code>（参考{' '}
          <code className="font-mono">.env.example</code>）
        </li>
        <li>
          ② 按下方模板填入任意 OpenAI 兼容服务的 baseURL、apiKey 和模型名（聚合平台一把 key
          可配多个模型，逗号分隔）
        </li>
        <li>
          ③ 重启 <code className="font-mono">pnpm dev</code> 后回到本页查看是否出现 Provider 卡片
        </li>
      </ol>
      <div className="relative mt-3 overflow-hidden rounded-lg border border-border-soft bg-card">
        <div className="absolute right-2 top-2 z-10">
          <CopyButton text={ENV_TEMPLATE} label="复制模板" />
        </div>
        <pre className="overflow-x-auto p-3 pr-24 font-mono text-xs leading-relaxed text-foreground">
          {ENV_TEMPLATE}
        </pre>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-warning-11">
        提示：支持 DeepSeek、Qwen、OpenRouter、OpenCode Zen 等任何 OpenAI 兼容端点。
      </p>
      {webConfigAvailable && (
        <p className="mt-1.5 text-xs leading-relaxed text-warning-11">
          也可以直接点击右上角「新建 Provider」，在网页端完成配置（保存后立即生效，无需重启）。
        </p>
      )}
    </div>
  );
}

/** 连接测试状态机：idle → testing → ok/fail；状态必须诚实，失败原因原样展示 */
type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; latencyMs?: number }
  | { phase: 'fail'; message: string };

/** 卡片右上角的来源中性小标签 */
function SourceTag({ source }: { source: ProviderSource }) {
  return (
    <span className="shrink-0 rounded-full border border-border-soft bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
      {source === 'db' ? '网页配置' : '环境变量'}
    </span>
  );
}

/** 单个已配置 Provider 卡片：等宽名称徽标 + 模型 chips + 来源标签 + 测试连接区；db 来源可编辑/删除 */
function ProviderCard({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderInfo;
  onEdit: (provider: ProviderInfo) => void;
  onDelete: (provider: ProviderInfo) => void;
}) {
  const [model, setModel] = useState<string>(provider.models[0] ?? '');
  const [manualModel, setManualModel] = useState('');
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  // 老后端不返回 source 字段，一律按 env 只读处理
  const source: ProviderSource = provider.source ?? 'env';
  const isDb = source === 'db';

  async function handleTest() {
    if (test.phase === 'testing') return;
    const target = (provider.models.length > 0 ? model : manualModel).trim();
    if (!target) {
      setTest({ phase: 'fail', message: '请先选择或填写要测试的模型名' });
      return;
    }
    setTest({ phase: 'testing' });
    try {
      const result = await providersApi.test(provider.name, target);
      if (result.ok) {
        setTest({ phase: 'ok', latencyMs: result.latencyMs });
      } else {
        setTest({ phase: 'fail', message: result.message ?? '连接失败' });
      }
    } catch (cause) {
      // 接口不可用（旧后端 404）/网络错误都如实按失败呈现
      setTest({
        phase: 'fail',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return (
    <article className="rounded-lg border border-border-soft bg-card p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="rounded-md bg-muted-strong px-2 py-0.5 font-mono text-sm font-medium text-sand-12">
          {provider.name}
        </span>
        {isDb && provider.apiKeyLast4 && (
          <span className="font-mono text-xs text-faint" title="密钥后四位">
            ····{provider.apiKeyLast4}
          </span>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-2">
          <SourceTag source={source} />
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success-9" aria-hidden />
            已加载
          </span>
        </span>
        {isDb && (
          <span className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={() => onEdit(provider)}>
              编辑
            </Button>
            <Button variant="danger" size="sm" onClick={() => onDelete(provider)}>
              删除
            </Button>
          </span>
        )}
      </header>
      {provider.models.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {provider.models.map((item) => (
            <li
              key={item}
              className="rounded-full border border-border-soft bg-muted px-2 py-0.5 font-mono text-2xs text-sand-11"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
      {/* 测试连接：只测当前选中的模型，结果即时反馈 */}
      <div className="mt-3 rounded-lg border border-border-soft bg-muted p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">测试连接</span>
          {provider.models.length > 0 ? (
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="h-7 rounded-md border border-input bg-card px-2 font-mono text-xs"
            >
              {provider.models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              placeholder="模型名（如 gpt-4o-mini）"
              className="h-7 w-48 rounded-md border border-input bg-card px-2 font-mono text-xs"
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={test.phase === 'testing'}
            onClick={() => void handleTest()}
          >
            {test.phase === 'testing' ? '测试中…' : '测试连接'}
          </Button>
          {test.phase === 'testing' && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="h-2.5 w-2.5 animate-spin rounded-full border border-sand-6 border-t-sand-9"
                aria-hidden
              />
              正在请求模型端点…
            </span>
          )}
          {test.phase === 'ok' && (
            <span className="inline-flex items-center gap-1.5 text-xs text-success-11">
              <span className="h-2 w-2 rounded-full bg-success-9" aria-hidden />
              连接正常{test.latencyMs != null ? ` · ${test.latencyMs}ms` : ''}
            </span>
          )}
          {test.phase === 'fail' && (
            <span
              className="inline-flex min-w-0 items-center gap-1.5 text-xs text-danger-11"
              title={test.message}
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-danger-9" aria-hidden />
              <span className="min-w-0 truncate">{test.message}</span>
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

/** 表单输入统一规格（与 MCP 页等既有表单一致） */
const INPUT_CLASS = 'h-8 rounded-md border border-input bg-card px-2.5 text-sm';

/** 表单字段容器：label + 控件 + 行内错误提示（错误优先于提示展示） */
function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <span className="mt-1 block text-xs text-danger-11">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

/** 新建/编辑弹窗的表单草稿；编辑时 apiKey 留空 = 不修改 */
interface ProviderDraft {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string;
}

/** 行内校验：名称小写规则 / URL http(s) 开头 / 必填项 */
function validateDraft(
  draft: ProviderDraft,
  mode: 'create' | 'edit',
): Partial<Record<keyof ProviderDraft, string>> {
  const errors: Partial<Record<keyof ProviderDraft, string>> = {};
  if (mode === 'create') {
    const name = draft.name.trim();
    if (!name) errors.name = '名称为必填项';
    else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      errors.name = '名称只能包含小写字母、数字和连字符';
  }
  const baseURL = draft.baseURL.trim();
  if (!baseURL) errors.baseURL = 'Base URL 为必填项';
  else if (!/^https?:\/\/\S+$/i.test(baseURL))
    errors.baseURL = 'Base URL 必须以 http:// 或 https:// 开头';
  if (mode === 'create' && draft.apiKey.length === 0) errors.apiKey = 'API Key 为必填项';
  if (draft.models.trim().length === 0) errors.models = '请至少填写一个模型名';
  return errors;
}

/** 模型列表归一化：按逗号拆分、去空白、去空项后重新拼接（后端按逗号分隔解析） */
function normalizeModels(models: string): string {
  return models
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(',');
}

/** 新建/编辑 Provider 弹窗：同一表单复用，编辑时名称只读、API Key 留空表示不修改 */
function ProviderEditorModal({
  mode,
  provider,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  /** 编辑目标（mode === 'edit' 时必有） */
  provider?: ProviderInfo;
  onClose: () => void;
  /** 保存成功后的回调（关闭弹窗、刷新列表与轻提示由页面层处理） */
  onSaved: () => void;
}) {
  // 编辑弹窗用既有配置预填（apiKey 永不回显，留空 = 不修改）；弹窗按 provider.name 设 key，重挂载时取值即准确
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    mode === 'edit' && provider
      ? {
          name: provider.name,
          baseURL: provider.baseURL ?? '',
          apiKey: '',
          models: provider.models.join(','),
        }
      : { name: '', baseURL: '', apiKey: '', models: '' },
  );
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 首次提交后转为实时校验，边改边消错
  const errors = attempted ? validateDraft(draft, mode) : {};

  function setField<K extends keyof ProviderDraft>(key: K, value: string): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  async function handleSubmit(): Promise<void> {
    if (submitting) return;
    setAttempted(true);
    if (Object.keys(validateDraft(draft, mode)).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (mode === 'create') {
        await providersApi.create({
          name: draft.name.trim(),
          baseURL: draft.baseURL.trim(),
          apiKey: draft.apiKey,
          models: normalizeModels(draft.models),
        });
      } else if (provider) {
        // 与后端约定：PATCH 省略字段保留原值；只携带与预填值有变更的字段，apiKey 留空即不修改
        const payload: ProviderUpdatePayload = {};
        const baseURL = draft.baseURL.trim();
        if (baseURL !== (provider.baseURL ?? '')) payload.baseURL = baseURL;
        const models = normalizeModels(draft.models);
        if (models !== provider.models.join(',')) payload.models = models;
        if (draft.apiKey.length > 0) payload.apiKey = draft.apiKey;
        if (Object.keys(payload).length === 0) {
          // 无任何变更：不发请求，直接关闭
          onClose();
          return;
        }
        await providersApi.update(provider.name, payload);
      }
      onSaved();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={mode === 'create' ? '新建 Provider' : '编辑 Provider'} onClose={onClose}>
      {submitError && (
        <p className="mb-3 rounded-md border border-danger-6 bg-danger-2 px-3 py-2 text-sm text-danger-11">
          {submitError}
        </p>
      )}
      <form
        className="space-y-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        {mode === 'create' ? (
          <Field label="名称" error={errors.name} hint="创建后不可修改，工作流节点通过名称引用">
            <input
              value={draft.name}
              onChange={(event) => setField('name', event.target.value)}
              placeholder="小写字母、数字、连字符"
              className={`${INPUT_CLASS} w-full font-mono`}
              autoFocus
            />
          </Field>
        ) : (
          <Field label="名称" hint="名称创建后不可修改">
            <input
              value={provider?.name ?? ''}
              readOnly
              className={`${INPUT_CLASS} w-full bg-muted font-mono text-muted-foreground`}
            />
          </Field>
        )}
        <Field label="Base URL" error={errors.baseURL}>
          <input
            value={draft.baseURL}
            onChange={(event) => setField('baseURL', event.target.value)}
            placeholder="https://api.example.com/v1"
            className={`${INPUT_CLASS} w-full font-mono`}
          />
        </Field>
        <Field label="API Key" error={errors.apiKey}>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => setField('apiKey', event.target.value)}
            placeholder={mode === 'create' ? '服务方密钥，仅保存在服务端' : '留空表示不修改'}
            className={`${INPUT_CLASS} w-full`}
            autoComplete="new-password"
          />
        </Field>
        <Field label="模型列表" error={errors.models} hint="多个模型用英文逗号分隔">
          <input
            value={draft.models}
            onChange={(event) => setField('models', event.target.value)}
            placeholder="model-a, model-b"
            className={`${INPUT_CLASS} w-full font-mono`}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? '保存中…' : mode === 'create' ? '创建' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** 设置页：LLM Provider 的查看与增删改查（env 来源只读，db 来源网页端可编辑），零配置时分步引导 */
export function SettingsPage({ onGoMcp, onGoWorkflows }: SettingsPageProps) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  /** 表单弹窗：null=关闭；create 新建；edit 编辑既有 db Provider */
  const [editor, setEditor] = useState<
    { mode: 'create' } | { mode: 'edit'; provider: ProviderInfo } | null
  >(null);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const result = await providersApi.list();
      setState({
        phase: 'ready',
        providers: result.providers,
        // 老后端不返回 configurable 字段（undefined）→ 只读，且不显示 FLOWAGENT_SECRET_KEY 横幅
        configurable: result.configurable,
      });
    } catch (cause) {
      if (cause instanceof TypeError) {
        setState({ phase: 'error', message: '无法连接服务器，请确认 server 已启动' });
      } else {
        setState({
          phase: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** 保存（新建/编辑）成功后的统一收尾：关闭弹窗 → 走既有加载链路刷新 → 轻提示 */
  const handleSaved = useCallback(async () => {
    setEditor(null);
    await refresh();
    setNotice({ kind: 'ok', text: '已保存，立即生效' });
  }, [refresh]);

  async function handleDelete(provider: ProviderInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `删除 Provider「${provider.name}」？`,
      description: `删除后将无法恢复，确认删除 Provider “${provider.name}”？`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await providersApi.remove(provider.name);
      await refresh();
      setNotice({ kind: 'ok', text: '已删除，立即生效' });
    } catch (cause) {
      setNotice({
        kind: 'error',
        text: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const ready = state.phase === 'ready' ? state : null;
  const configurable = ready?.configurable === true;
  const showSecretBanner = ready?.configurable === false;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          LLM Provider 支持网页端配置（保存后立即生效）或环境变量配置（重启 server 后生效）
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">已配置的 LLM Provider</h2>
          <Button
            variant="primary"
            size="sm"
            disabled={!configurable}
            title={configurable ? undefined : '当前服务端未启用网页端配置'}
            onClick={() => setEditor({ mode: 'create' })}
          >
            <PlusIcon />
            新建 Provider
          </Button>
        </div>

        {showSecretBanner && (
          <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-12">
            网页端保存密钥需要服务端设置环境变量 FLOWAGENT_SECRET_KEY 后重启
          </p>
        )}

        {ready && notice && (
          <div
            className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
              notice.kind === 'ok'
                ? 'border-success-6 bg-success-2 text-success-11'
                : 'border-danger-6 bg-danger-2 text-danger-11'
            }`}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {notice.kind === 'ok' && <CheckIcon />}
              <span className="min-w-0 break-all">{notice.text}</span>
            </span>
            {notice.kind === 'error' && (
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="shrink-0 text-danger-11 hover:text-danger-12"
                aria-label="关闭提示"
              >
                <XIcon />
              </button>
            )}
          </div>
        )}

        {state.phase === 'loading' && <LoadingRows rows={2} />}
        {state.phase === 'error' && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-12">
            <span>{state.message}</span>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
        {ready && ready.providers.length === 0 && (
          <ZeroConfigGuide webConfigAvailable={configurable} />
        )}
        {ready &&
          ready.providers.map((provider) => (
            <ProviderCard
              key={provider.name}
              provider={provider}
              onEdit={(target) => setEditor({ mode: 'edit', provider: target })}
              onDelete={(target) => void handleDelete(target)}
            />
          ))}
      </section>

      <section className="rounded-lg border border-border-soft bg-muted p-4">
        <h2 className="text-sm font-medium text-foreground">安全说明</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          API key 只保存在服务端（环境变量，或启用 FLOWAGENT_SECRET_KEY
          后加密存储于数据库），不会写入日志或事件流，也绝不会通过本页接口返回明文；请勿把 .env
          文件提交到仓库。
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">下一步</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <article className="flex flex-col rounded-lg border border-border-soft bg-card p-4 shadow-xs">
            <h3 className="text-sm font-semibold text-foreground">① 注册 MCP Server</h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
              让工作流能调用工具。
            </p>
            {onGoMcp && (
              <div className="mt-3">
                <Button variant="secondary" onClick={onGoMcp}>
                  前往 MCP Servers 页 →
                </Button>
              </div>
            )}
          </article>
          <article className="flex flex-col rounded-lg border border-border-soft bg-card p-4 shadow-xs">
            <h3 className="text-sm font-semibold text-foreground">② 新建工作流</h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
              编排节点并运行。
            </p>
            {onGoWorkflows && (
              <div className="mt-3">
                <Button variant="secondary" onClick={onGoWorkflows}>
                  前往工作流列表 →
                </Button>
              </div>
            )}
          </article>
        </div>
      </section>

      {editor && (
        <ProviderEditorModal
          key={editor.mode === 'edit' ? editor.provider.name : 'create'}
          mode={editor.mode}
          provider={editor.mode === 'edit' ? editor.provider : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => void handleSaved()}
        />
      )}
    </div>
  );
}
