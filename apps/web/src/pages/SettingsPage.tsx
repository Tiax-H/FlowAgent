import { useCallback, useEffect, useState } from 'react';

import { providersApi, type ProviderInfo } from '../api/providers';
import { Button, CopyButton, LoadingRows } from '../components/ui';

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
  | { phase: 'ready'; providers: ProviderInfo[] }
  | { phase: 'error'; message: string };

/** 零配置时的琥珀色引导卡：分步说明 + 可复制 .env 模板 */
function ZeroConfigGuide() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h3 className="text-sm font-semibold text-amber-800">尚未配置任何 LLM Provider</h3>
      <ol className="mt-2 space-y-1.5 text-sm leading-relaxed text-amber-900">
        <li>
          ① 在仓库根目录创建/编辑 <code className="font-mono">.env</code>（参考{' '}
          <code className="font-mono">.env.example</code>）
        </li>
        <li>
          ② 按下方模板填入任意 OpenAI 兼容服务的 baseURL、apiKey 和模型名（聚合平台一把 key
          可配多个模型，逗号分隔）
        </li>
        <li>
          ③ 重启 <code className="font-mono">pnpm dev</code>{' '}
          后回到本页查看是否出现 Provider 卡片
        </li>
      </ol>
      <div className="relative mt-3 overflow-hidden rounded-lg border border-amber-200 bg-white">
        <div className="absolute right-2 top-2 z-10">
          <CopyButton text={ENV_TEMPLATE} label="复制模板" />
        </div>
        <pre className="overflow-x-auto p-3 pr-24 font-mono text-xs leading-relaxed text-neutral-700">
          {ENV_TEMPLATE}
        </pre>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-amber-700">
        提示：支持 DeepSeek、Qwen、OpenRouter、OpenCode Zen 等任何 OpenAI 兼容端点。
      </p>
    </div>
  );
}

/** 单个已配置 Provider 卡片：等宽名称徽标 + 模型 chips + 右上角「已生效」点 */
function ProviderCard({ provider }: { provider: ProviderInfo }) {
  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-4">
      <header className="flex items-center gap-3">
        <span className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-sm font-semibold text-neutral-800">
          {provider.name}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-emerald-600">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          已生效
        </span>
      </header>
      {provider.models.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {provider.models.map((model) => (
            <li
              key={model}
              className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-mono text-xs text-neutral-600"
            >
              {model}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** 设置页：查看已配置的 LLM Provider，零配置时分步引导用户通过环境变量完成首次配置 */
export function SettingsPage({ onGoMcp, onGoWorkflows }: SettingsPageProps) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  const refresh = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const { providers } = await providersApi.list();
      setState({ phase: 'ready', providers });
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="mt-1 text-sm text-neutral-500">
          LLM Provider 通过环境变量配置，修改后需重启 server 生效
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-600">已配置的 LLM Provider</h2>
        {state.phase === 'loading' && <LoadingRows rows={2} />}
        {state.phase === 'error' && (
          <div className="flex items-center justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            <span>{state.message}</span>
            <Button variant="secondary" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
        {state.phase === 'ready' && state.providers.length === 0 && <ZeroConfigGuide />}
        {state.phase === 'ready' &&
          state.providers.map((provider) => (
            <ProviderCard key={provider.name} provider={provider} />
          ))}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <h2 className="text-sm font-medium text-neutral-600">安全说明</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-500">
          API key 只保存在服务端环境变量中，不会写入数据库、日志或事件流，也绝不会通过本页接口返回；请勿把
          .env 文件提交到仓库。
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-600">下一步</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <article className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-neutral-800">① 注册 MCP Server</h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-neutral-500">
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
          <article className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-neutral-800">② 新建工作流</h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-neutral-500">
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
    </div>
  );
}
