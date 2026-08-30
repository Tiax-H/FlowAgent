import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import type {
  AgentNodeData,
  ConditionBranch,
  ConditionNodeData,
  EndNodeData,
  HumanNodeData,
  LoopNodeData,
  LlmNodeData,
  McpToolBinding,
  NodeType,
  StartNodeData,
  ToolNodeData,
  TransformNodeData,
  WorkflowDefinition,
  WorkflowSubgraph,
} from '@flowagent/shared';

import { mcpApi, type McpTool } from '../../api/mcp';
import { providersApi, type ProviderInfo } from '../../api/providers';
import { CheckIcon, XIcon } from '../../components/icons';
import { Button, confirmDialog } from '../../components/ui';
import { collectInputFieldNames } from '../../lib/inputSkeleton';
import { NODE_TYPE_META } from '../types';

/** 同画布其他节点的摘要，供「插入引用」生成 {{节点id.output}} */
export interface PeerNode {
  id: string;
  name?: string;
}

interface PropertyPanelProps {
  node: Node;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  /** 同画布其他节点摘要；缺省时自动从 ReactFlow 实例读取（无 Provider 环境则降级为空列表） */
  peerNodes?: PeerNode[];
  /** 当前画布对应的完整工作流定义：Start 面板用它汇总全图 {{input.*}} 引用；缺省时按无字段降级 */
  definition?: WorkflowDefinition;
}

interface NodeDataShape extends Record<string, unknown> {
  nodeType: NodeType;
  name: string;
  __nodeExtras?: { timeoutMs?: number; retry?: { maxAttempts?: number } };
}

/** 模板语法的固定帮助文案 */
const TEMPLATE_HELP =
  '模板语法：{{input.xxx}} 引用运行输入，{{节点id.output}} 引用上游输出';

/** Provider / 模型下拉中代表“切回手动输入”的哨兵值 */
const MANUAL_OPTION = '__manual__';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {hint && <span className="ml-1 font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * 与 Field 等价的区块容器，但外层用 div：内部含按钮/多控件时，
 * 避免 label 的隐式焦点转发把点击劫持到第一个输入框。
 */
function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">
        {label}
        {hint && <span className="ml-1 font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

const inputClass =
  'h-8 w-full rounded-md border border-input bg-card px-2.5 text-sm placeholder:text-faint';

function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      className={`${inputClass} ${props.mono ? 'font-mono text-xs' : ''}`}
    />
  );
}

function NumberInput(props: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      value={props.value ?? ''}
      onChange={(event) => {
        if (event.target.value === '') {
          props.onChange(undefined);
          return;
        }
        const parsed = Number(event.target.value);
        // 中间态（如 "-"）与非法输入不写回，避免 NaN 进定义
        props.onChange(Number.isFinite(parsed) ? parsed : undefined);
      }}
      placeholder={props.placeholder}
      className={inputClass}
    />
  );
}

/** JSON 文本域：本地草稿编辑，合法即提交，非法标红提示（不吞键击、不清空内容） */
function JsonField(props: {
  value: unknown;
  onChange: (value: unknown) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(props.value ?? {}, null, 0));
  const [invalid, setInvalid] = useState(false);
  /** 最近一次本地提交的值：外部值与之不同（切换节点/导入）才回写草稿，避免提交后光标跳动 */
  const lastCommittedRef = useRef<unknown>(props.value);

  useEffect(() => {
    if (JSON.stringify(props.value ?? {}) !== JSON.stringify(lastCommittedRef.current ?? {})) {
      setDraft(JSON.stringify(props.value ?? {}, null, 0));
      setInvalid(false);
      lastCommittedRef.current = props.value;
    }
  }, [props.value]);

  return (
    <div>
      <textarea
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            lastCommittedRef.current = parsed;
            props.onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        rows={props.rows ?? 4}
        placeholder={props.placeholder}
        className={`${inputClass} py-1.5 font-mono text-xs ${invalid ? 'border-danger-7 bg-danger-2' : ''}`}
      />
      {invalid && <p className="mt-1 text-2xs text-danger-11">JSON 格式暂不合法，修正后生效</p>}
    </div>
  );
}

function TextArea(props: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
  /** 回调 ref：供调用方拿到元素以读取/恢复光标位置 */
  inputRef?: (element: HTMLTextAreaElement | null) => void;
}) {
  return (
    <textarea
      ref={props.inputRef}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      className={`${inputClass} py-1.5 ${props.mono ? 'font-mono text-xs' : ''}`}
    />
  );
}

/** 「插入引用」按钮行：列出同画布其他节点，点击把对应模板片段交给 onInsert */
function TemplateInsertRow({ peers, onInsert }: { peers: PeerNode[]; onInsert: (snippet: string) => void }) {
  if (peers.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-2xs text-faint">插入引用：</span>
      {peers.map((peer) => (
        <button
          key={peer.id}
          type="button"
          title={`插入 {{${peer.id}.output}}`}
          onClick={() => onInsert(`{{${peer.id}.output}}`)}
          className="max-w-28 truncate rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted-strong"
        >
          {peer.name || peer.id}
        </button>
      ))}
    </div>
  );
}

/**
 * Start 面板的「运行输入字段」只读说明区：汇总全图 {{input.*}} 顶层字段名，
 * 让「任务在运行时输入」这条线索在编辑器里可见。无字段时给出如何声明的中性引导。
 */
function RunInputFieldsBlock({ fieldNames }: { fieldNames: string[] }) {
  return (
    <FieldBlock label="运行输入字段" hint="只读">
      {fieldNames.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1">
            {fieldNames.map((name) => (
              <span
                key={name}
                className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>
          <p className="text-2xs text-faint">
            点右上角『运行』后在弹窗中填写这些字段——这就是本次任务的入口。
          </p>
        </>
      ) : (
        <p className="text-2xs text-faint">
          尚未声明运行输入：可在下方输入 Schema 中定义，或在任意 Agent/LLM
          提示词中插入 {'{{input.任务名}}'} 引用，运行时会自动生成填写框。
        </p>
      )}
    </FieldBlock>
  );
}

/**
 * 提示词类多行字段：「插入引用」按钮行 + 文本域（光标处追加）+ 模板语法帮助。
 * peers 为空时按钮行自动省略，帮助文案保留。
 */
function PromptField({
  label,
  hint,
  value,
  onChange,
  peers,
  rows,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  peers: PeerNode[];
  rows?: number;
}) {
  const [textAreaEl, setTextAreaEl] = useState<HTMLTextAreaElement | null>(null);

  const insertSnippet = (snippet: string): void => {
    const el = textAreaEl;
    const start = Math.min(el?.selectionStart ?? value.length, value.length);
    const end = Math.min(el?.selectionEnd ?? start, value.length);
    onChange(value.slice(0, start) + snippet + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  return (
    <FieldBlock label={label} hint={hint}>
      <TemplateInsertRow peers={peers} onInsert={insertSnippet} />
      <TextArea value={value} onChange={onChange} rows={rows} inputRef={setTextAreaEl} />
      <p className="text-2xs text-faint">{TEMPLATE_HELP}</p>
    </FieldBlock>
  );
}

/** 键→模板 映射编辑（End.outputs / Transform.template 共用） */
function TemplateMapEditor({
  value,
  onChange,
  keyPlaceholder,
  peers,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  keyPlaceholder: string;
  peers?: PeerNode[];
}) {
  const entries = Object.entries(value);
  /** 最近获得焦点的模板输入框：插入引用的落点 */
  const focusedRef = useRef<{ el: HTMLInputElement; index: number } | null>(null);

  /** 保序更新：按原顺序重建，避免重命名字段时行跳位 */
  const rebuild = (updated: Array<[string, string]>): Record<string, string> => {
    const next: Record<string, string> = {};
    for (const [key, template] of updated) {
      if (key === '') continue;
      next[key] = template;
    }
    return next;
  };

  const insertSnippet = (snippet: string): void => {
    const target = focusedRef.current;
    const entry = target ? entries[target.index] : undefined;
    if (!target || !entry) return;
    const [key, template] = entry;
    const el = target.el;
    const start = Math.min(el.selectionStart ?? template.length, template.length);
    const end = Math.min(el.selectionEnd ?? start, template.length);
    onChange(
      rebuild(
        entries.map((item, i) =>
          i === target.index ? ([key, template.slice(0, start) + snippet + template.slice(end)] as [string, string]) : item,
        ),
      ),
    );
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  return (
    <div className="space-y-1">
      {peers && peers.length > 0 && <TemplateInsertRow peers={peers} onInsert={insertSnippet} />}
      {entries.map(([key, template], index) => (
        <div key={index} className="flex gap-1">
          <input
            value={key}
            onChange={(event) => {
              const newKey = event.target.value;
              // 与其他字段重名时不更新，避免静默合并
              if (entries.some(([other], i) => i !== index && other === newKey)) return;
              onChange(rebuild(entries.map((entry, i) => (i === index ? [newKey, entry[1]] : entry))));
            }}
            placeholder={keyPlaceholder}
            className="h-8 w-24 rounded-md border border-input bg-card px-2.5 text-sm"
          />
          <input
            value={template}
            onFocus={(event) => {
              focusedRef.current = { el: event.currentTarget, index };
            }}
            onChange={(event) => {
              const next = { ...value };
              next[key] = event.target.value;
              onChange(next);
            }}
            placeholder="{{node_x.output}}"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
            className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-danger-2 hover:text-danger-11"
            title="删除该字段"
          >
            <XIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          if (entries.some(([key]) => key === '')) return;
          onChange({ ...value, '': '' });
        }}
        className="rounded-md border border-input bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        + 添加字段
      </button>
      <p className="text-2xs text-faint">{TEMPLATE_HELP}</p>
    </div>
  );
}

/** Provider 选择：有配置时走下拉（末项可切回手输），未配置项给出橙色警示 */
function ProviderPicker({
  value,
  onChange,
  providers,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  providers: ProviderInfo[];
  placeholder?: string;
}) {
  const [manualMode, setManualMode] = useState(false);
  const names = providers.map((provider) => provider.name);

  if (names.length === 0) {
    // Provider 配置为空或加载失败：静默退化为自由输入
    return <TextInput value={value} onChange={onChange} placeholder={placeholder ?? 'openai / aggregator'} />;
  }

  const known = names.includes(value);
  const showInput = manualMode || !known;

  return (
    <div className="space-y-1">
      <select
        value={!manualMode && known ? value : MANUAL_OPTION}
        onChange={(event) => {
          const next = event.target.value;
          if (next === MANUAL_OPTION) {
            setManualMode(true);
            return;
          }
          setManualMode(false);
          onChange(next);
        }}
        className={inputClass}
      >
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={MANUAL_OPTION}>手动输入…</option>
      </select>
      {showInput && (
        <>
          <TextInput value={value} onChange={onChange} placeholder={placeholder ?? 'openai / aggregator'} />
          {!known && value.trim() !== '' && (
            <p className="text-2xs text-warning-11">未配置的 Provider，保存后运行会失败</p>
          )}
        </>
      )}
    </div>
  );
}

/** 模型选择：所选 Provider 有模型列表时走下拉 + “自定义…”，否则保持手输 */
function ModelPicker({
  provider,
  value,
  onChange,
  providers,
}: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
  providers: ProviderInfo[];
}) {
  const [manualMode, setManualMode] = useState(false);
  const models = providers.find((item) => item.name === provider)?.models ?? [];

  if (models.length === 0) {
    return <TextInput value={value} onChange={onChange} placeholder="deepseek-chat" />;
  }

  const known = models.includes(value);
  const showInput = manualMode || !known;

  return (
    <div className="space-y-1">
      <select
        value={!manualMode && known ? value : MANUAL_OPTION}
        onChange={(event) => {
          const next = event.target.value;
          if (next === MANUAL_OPTION) {
            setManualMode(true);
            return;
          }
          setManualMode(false);
          onChange(next);
        }}
        className={inputClass}
      >
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value={MANUAL_OPTION}>自定义…</option>
      </select>
      {showInput && <TextInput value={value} onChange={onChange} placeholder={models[0] ?? 'deepseek-chat'} />}
    </div>
  );
}

/* ---------- Provider 连通性直达测试（Agent / LLM 共用，交互语义与设置页一致） ---------- */

/** 连接测试状态机：idle → testing → ok/fail；失败原因原样展示 */
type ProviderTestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; latencyMs?: number }
  | { phase: 'fail'; message: string };

/** Provider 与模型都已填写时显示「测试连通」；结果行内即时反馈，宽度自适应不挤压表单 */
function ProviderTestRow({ provider, model }: { provider: string; model: string }) {
  const [test, setTest] = useState<ProviderTestState>({ phase: 'idle' });
  /** 请求序号：provider/model 在请求途中被修改时使旧响应失效 */
  const requestSeqRef = useRef(0);
  const ready = provider.trim() !== '' && model.trim() !== '';

  // 表单值变化即失效回 idle，避免展示与新配置无关的旧结果
  useEffect(() => {
    requestSeqRef.current += 1;
    setTest({ phase: 'idle' });
  }, [provider, model]);

  if (!ready) return null;

  function handleTest(): void {
    if (test.phase === 'testing') return;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setTest({ phase: 'testing' });
    void providersApi
      .test(provider.trim(), model.trim())
      .then((result) => {
        if (requestSeqRef.current !== seq) return;
        if (result.ok) setTest({ phase: 'ok', latencyMs: result.latencyMs });
        else setTest({ phase: 'fail', message: result.message ?? '连接失败' });
      })
      .catch((cause: unknown) => {
        // 接口不可用（旧后端 404）/网络错误都如实按失败呈现
        if (requestSeqRef.current !== seq) return;
        setTest({
          phase: 'fail',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        disabled={test.phase === 'testing'}
        onClick={handleTest}
      >
        测试连通
      </Button>
      {test.phase === 'testing' && (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-sand-6 border-t-sand-9"
            aria-hidden
          />
          测试中…
        </span>
      )}
      {test.phase === 'ok' && (
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-success-11">
          <CheckIcon />
          <span className="min-w-0 truncate">
            连接正常{test.latencyMs != null ? ` · ${test.latencyMs}ms` : ''}
          </span>
        </span>
      )}
      {test.phase === 'fail' && (
        <span
          className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs text-danger-11"
          title={test.message}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-danger-9" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{test.message}</span>
        </span>
      )}
    </div>
  );
}

/* ---------- Tool 参数表单化：从 MCP inputSchema 收窄出可渲染的字段 ---------- */

interface ParsedToolProperty {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
}

interface ParsedToolSchema {
  properties: ParsedToolProperty[];
  required: string[];
}

/** 名字含这些关键词的 string 参数按长文本渲染（textarea） */
const LONG_TEXT_NAME_PATTERN = /diff|code|text|content/i;
/** description 明确提示长内容的也算长文本 */
const LONG_TEXT_DESC_PATTERN = /long|multiline|multi-line|长文本|多行|较长/i;

/** 把 unknown 形态的 JSON Schema 安全收窄为可表单化的字段列表；不支持/为空时返回 null */
function parseToolSchema(inputSchema: unknown): ParsedToolSchema | null {
  if (typeof inputSchema !== 'object' || inputSchema === null) return null;
  const record = inputSchema as Record<string, unknown>;
  const rawProperties = record['properties'];
  if (typeof rawProperties !== 'object' || rawProperties === null || Array.isArray(rawProperties)) return null;

  const requiredRaw = record['required'];
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((item): item is string => typeof item === 'string')
    : [];

  const properties: ParsedToolProperty[] = [];
  for (const [name, raw] of Object.entries(rawProperties as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const info = raw as Record<string, unknown>;
    const type = info['type'];
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    properties.push({
      name,
      type,
      description: typeof info['description'] === 'string' ? info['description'] : undefined,
    });
  }
  if (properties.length === 0) return null;
  return { properties, required };
}

function ToolArgsForm({
  args,
  schema,
  onChange,
}: {
  args: Record<string, unknown>;
  schema: ParsedToolSchema;
  onChange: (args: Record<string, unknown>) => void;
}) {
  const setArg = (name: string, value: unknown): void => {
    const next: Record<string, unknown> = { ...args };
    if (value === undefined) {
      delete next[name];
    } else {
      next[name] = value;
    }
    onChange(next);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border-soft p-2.5">
      {schema.properties.map((property) => {
        const required = schema.required.includes(property.name);
        const current = args[property.name];
        const isLongText =
          property.type === 'string' &&
          (LONG_TEXT_NAME_PATTERN.test(property.name) ||
            (property.description !== undefined && LONG_TEXT_DESC_PATTERN.test(property.description)));
        return (
          <div key={property.name}>
            <div className="mb-0.5 flex items-baseline gap-1">
              <span className="text-xs font-medium text-foreground">
                {required && <span className="mr-0.5 text-danger-11">*</span>}
                {property.name}
              </span>
              <span className="text-2xs text-faint">{property.type}</span>
            </div>
            {property.type === 'boolean' ? (
              <select
                value={
                  current === undefined
                    ? ''
                    : current === true
                      ? 'true'
                      : current === false
                        ? 'false'
                        : '__raw__'
                }
                onChange={(event) => {
                  const next = event.target.value;
                  // 三态与运行输入表单一致：不传 = 从参数里移除该键
                  if (next === '') setArg(property.name, undefined);
                  else if (next === 'true') setArg(property.name, true);
                  else if (next === 'false') setArg(property.name, false);
                }}
                className={inputClass}
              >
                <option value="">不传（保持未设置）</option>
                <option value="true">true</option>
                <option value="false">false</option>
                {/* 兼容已有 definition 里经原始 JSON 写入的非布尔值：只展示，不静默改写 */}
                {current !== undefined && current !== true && current !== false && (
                  <option value="__raw__">
                    当前值 {JSON.stringify(current)}（非布尔，选择 true/false 将覆盖）
                  </option>
                )}
              </select>
            ) : property.type === 'number' ? (
              <NumberInput
                value={typeof current === 'number' ? current : undefined}
                onChange={(value) => setArg(property.name, value)}
              />
            ) : isLongText ? (
              <TextArea
                value={typeof current === 'string' ? current : ''}
                onChange={(value) => setArg(property.name, value)}
                rows={3}
                mono
              />
            ) : (
              <TextInput
                value={typeof current === 'string' ? current : ''}
                onChange={(value) => setArg(property.name, value)}
                mono
              />
            )}
            {property.description && <p className="mt-0.5 text-2xs text-faint">{property.description}</p>}
          </div>
        );
      })}
      <p className="text-2xs text-faint">参数值支持模板：{'{{input.xxx}}'} 与 {'{{节点id.output}}'}</p>
    </div>
  );
}

function ToolForm({
  data,
  onChange,
  tools,
  toolsError,
}: {
  data: ToolNodeData;
  /** 与面板同宽度的 patch 通道：JsonField 提交的原始 JSON 需原样透传（与既有行为一致） */
  onChange: (patch: Record<string, unknown>) => void;
  tools: McpTool[];
  toolsError: string | null;
}) {
  const qualifiedName = `${data.server}:${data.tool}`;
  const selectedTool = tools.find((tool) => tool.qualifiedName === qualifiedName);
  const schema = selectedTool ? parseToolSchema(selectedTool.inputSchema) : null;

  return (
    <div className="space-y-3">
      <Field label="选择 MCP 工具" hint="直调模式：执行到该节点时调用一次">
        {tools.length === 0 ? (
          toolsError ? (<p className="text-xs text-danger-11">工具列表加载失败：{toolsError}</p>) : (<p className="text-xs text-faint">注册表为空，请先在 MCP Servers 页添加</p>)
        ) : (
          <select
            value={`${data.server ?? ''}:${data.tool ?? ''}`}
            onChange={(event) => {
              const [server, tool] = event.target.value.split(':');
              onChange({ server: server ?? '', tool: tool ?? '' });
            }}
            className={inputClass}
          >
            <option value="">选择工具…</option>
            {tools.map((tool) => (
              <option key={tool.qualifiedName} value={tool.qualifiedName}>
                {tool.qualifiedName}
              </option>
            ))}
          </select>
        )}
      </Field>
      {schema ? (
        <FieldBlock label="参数" hint="标 * 为必填，按工具 Schema 自动生成">
          <ToolArgsForm args={data.args ?? {}} schema={schema} onChange={(args) => onChange({ args })} />
          <details className="rounded-lg border border-border-soft p-2.5">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              高级：编辑原始 JSON
            </summary>
            <div className="mt-2">
              <JsonField value={data.args ?? {}} onChange={(args) => onChange({ args })} rows={4} />
            </div>
          </details>
        </FieldBlock>
      ) : (
        <Field label="参数 JSON（值支持模板）">
          <JsonField
            value={data.args ?? {}}
            onChange={(args) => onChange({ args })}
            rows={4}
            placeholder='{"query": "{{input.query}}"}'
          />
        </Field>
      )}
      <Field label="超时 (ms)">
        <NumberInput
          value={data.timeoutMs}
          onChange={(timeoutMs) => onChange({ timeoutMs })}
          placeholder="30000"
        />
      </Field>
    </div>
  );
}

/** Provider 列表加载失败警示条：不静默降级，保留手输兜底并提供重试 */
function ProvidersWarning({
  error,
  retrying,
  onRetry,
}: {
  error: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-warning-6 bg-warning-3 px-2.5 py-1.5 text-xs text-warning-12">
      <span className="min-w-0 flex-1">
        无法加载可用模型列表，可手动填写
        <span className="ml-1 text-warning-11">（{error}）</span>
      </span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="shrink-0 rounded-md border border-warning-7 bg-card px-1.5 py-0.5 text-warning-11 transition-colors hover:bg-warning-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {retrying ? '重试中…' : '重试'}
      </button>
    </div>
  );
}

function AgentForm({
  data,
  onChange,
  tools,
  toolsError,
  providers,
  providersError,
  providersLoading,
  onRetryProviders,
  peers,
}: {
  data: AgentNodeData;
  onChange: (patch: Partial<AgentNodeData>) => void;
  tools: McpTool[];
  toolsError: string | null;
  providers: ProviderInfo[];
  providersError: string | null;
  providersLoading: boolean;
  onRetryProviders: () => void;
  peers: PeerNode[];
}) {
  const bound: McpToolBinding[] = data.tools ?? [];
  return (
    <div className="space-y-3">
      <ProvidersWarning error={providersError} retrying={providersLoading} onRetry={onRetryProviders} />
      <Field label="Provider" hint="LLM 服务方，来自系统 Provider 配置">
        <ProviderPicker
          value={data.provider ?? ''}
          onChange={(provider) => onChange({ provider })}
          providers={providers}
          placeholder="openai / aggregator"
        />
      </Field>
      <Field label="模型" hint="所选 Provider 支持的模型名">
        <ModelPicker
          provider={data.provider ?? ''}
          value={data.model ?? ''}
          onChange={(model) => onChange({ model })}
          providers={providers}
        />
      </Field>
      <ProviderTestRow provider={data.provider ?? ''} model={data.model ?? ''} />
      <Field label="System Prompt" hint="设定角色与行为约束">
        <TextArea
          value={data.systemPrompt ?? ''}
          onChange={(systemPrompt) => onChange({ systemPrompt })}
        />
      </Field>
      <PromptField
        label="提示词"
        hint="运行时注入上游输出"
        value={data.prompt ?? ''}
        onChange={(prompt) => onChange({ prompt })}
        peers={peers}
      />
      <Field label="绑定 MCP 工具" hint="绑定后，模型会在对话中自主决定何时调用">
        {tools.length === 0 ? (
          toolsError ? (<p className="text-xs text-danger-11">工具列表加载失败：{toolsError}</p>) : (<p className="text-xs text-faint">注册表为空，请先在 MCP Servers 页添加</p>)
        ) : (
          <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-border-soft p-2.5">
            {tools.map((tool) => {
              const [server, name] = tool.qualifiedName.split(':');
              const checked = bound.some((item) => item.server === server && item.tool === name);
              return (
                <label key={tool.qualifiedName} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange({
                        tools: checked
                          ? bound.filter((item) => !(item.server === server && item.tool === name))
                          : [...bound, { server: server!, tool: name! }],
                      })
                    }
                    className="h-3.5 w-3.5 accent-brand-9"
                  />
                  <code className="text-2xs">{tool.qualifiedName}</code>
                </label>
              );
            })}
          </div>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="最大轮数" hint="ReAct 循环上限">
          <NumberInput
            value={data.maxIterations}
            onChange={(maxIterations) => onChange({ maxIterations })}
            placeholder="8"
          />
        </Field>
        <Field label="Temperature" hint="越高越随机">
          <NumberInput
            value={data.temperature}
            onChange={(temperature) => onChange({ temperature })}
            placeholder="0.7"
          />
        </Field>
      </div>
    </div>
  );
}

function LlmForm({
  data,
  onChange,
  providers,
  providersError,
  providersLoading,
  onRetryProviders,
  peers,
}: {
  data: LlmNodeData;
  onChange: (patch: Partial<LlmNodeData>) => void;
  providers: ProviderInfo[];
  providersError: string | null;
  providersLoading: boolean;
  onRetryProviders: () => void;
  peers: PeerNode[];
}) {
  return (
    <div className="space-y-3">
      <ProvidersWarning error={providersError} retrying={providersLoading} onRetry={onRetryProviders} />
      <Field label="Provider" hint="LLM 服务方，来自系统 Provider 配置">
        <ProviderPicker
          value={data.provider ?? ''}
          onChange={(provider) => onChange({ provider })}
          providers={providers}
          placeholder="openai / aggregator"
        />
      </Field>
      <Field label="模型" hint="所选 Provider 支持的模型名">
        <ModelPicker
          provider={data.provider ?? ''}
          value={data.model ?? ''}
          onChange={(model) => onChange({ model })}
          providers={providers}
        />
      </Field>
      <ProviderTestRow provider={data.provider ?? ''} model={data.model ?? ''} />
      <PromptField
        label="提示词"
        hint="运行时注入上游输出"
        value={data.prompt ?? ''}
        onChange={(prompt) => onChange({ prompt })}
        peers={peers}
      />
      <Field label="Temperature" hint="采样温度，越高越随机">
        <NumberInput
          value={data.temperature}
          onChange={(temperature) => onChange({ temperature })}
          placeholder="0.7"
        />
      </Field>
    </div>
  );
}

function ConditionForm({
  data,
  onChange,
}: {
  data: ConditionNodeData;
  onChange: (patch: Partial<ConditionNodeData>) => void;
}) {
  const branches: ConditionBranch[] = data.branches ?? [];
  return (
    <div className="space-y-2">
      {branches.map((branch, index) => (
        <div key={index} className="space-y-1 rounded-lg border border-border-soft p-2.5">
          <div className="flex gap-1">
            <input
              value={branch.id}
              onChange={(event) => {
                const next = [...branches];
                if (next[index]) next[index] = { ...branch, id: event.target.value };
                onChange({ branches: next });
              }}
              placeholder="分支 id（sourceHandle）"
              className="h-8 w-32 rounded-md border border-input bg-card px-2.5 font-mono text-xs"
            />
            <input
              value={branch.label ?? ''}
              onChange={(event) => {
                const next = [...branches];
                if (next[index]) next[index] = { ...branch, label: event.target.value };
                onChange({ branches: next });
              }}
              placeholder="显示名（可选）"
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-sm"
            />
            <button
              type="button"
              onClick={() => onChange({ branches: branches.filter((_, i) => i !== index) })}
              className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-danger-2 hover:text-danger-11"
              title="删除该分支"
            >
              <XIcon />
            </button>
          </div>
          <input
            value={branch.expression}
            onChange={(event) => {
              const next = [...branches];
              if (next[index]) next[index] = { ...branch, expression: event.target.value };
              onChange({ branches: next });
            }}
            placeholder="表达式，如 result.score > 0.5（默认分支填 true）"
            className="h-8 w-full rounded-md border border-input bg-card px-2.5 font-mono text-xs"
          />
          <p className="text-2xs leading-relaxed text-faint">
            {'可用变量：input.xxx（运行输入）与各上游节点 节点id.output；比较 > >= < <= == !=，逻辑 && || !；最后一个恒真分支作为默认路径。'}
          </p>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            branches: [...branches, { id: `branch_${branches.length + 1}`, expression: 'true' }],
          })
        }
        className="rounded-md border border-input bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        + 添加分支
      </button>
    </div>
  );
}

/** Loop 子图最小合法骨架：start → end 两节点一条边（与 WorkflowSubgraph 结构对齐，无额外版本字段） */
function buildSubgraphSkeleton(): WorkflowSubgraph {
  return {
    nodes: [
      { id: 'sub_start', type: 'start', name: '循环体开始', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'sub_end',
        type: 'end',
        name: '循环体结束',
        position: { x: 240, y: 0 },
        data: { outputs: { result: '{{loop.item}}' } },
      },
    ],
    edges: [{ id: 'edge_sub_start_sub_end', source: 'sub_start', target: 'sub_end' }],
  };
}

export function PropertyPanel({ node, onChange, onDelete, peerNodes, definition }: PropertyPanelProps) {
  const data = node.data as NodeDataShape;
  const meta = NODE_TYPE_META[data.nodeType];
  const [tools, setTools] = useState<McpTool[]>([]);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);

  useEffect(() => {
    if (data.nodeType === 'agent' || data.nodeType === 'tool') {
      setToolsError(null);
      void mcpApi
        .listTools()
        .then(setTools)
        .catch((cause: unknown) => {
          // 区分"没配置"与"加载失败"，网络错误不能伪装成空注册表
          setTools([]);
          setToolsError(cause instanceof Error ? cause.message : String(cause));
        });
    }
  }, [data.nodeType]);

  /** 加载 Provider 列表；失败时在面板警示（保留手输兜底），可重试 */
  const loadProviders = useCallback(() => {
    setProvidersLoading(true);
    setProvidersError(null);
    void providersApi
      .list()
      .then((result) => {
        setProviders(result.providers ?? []);
        setProvidersError(null);
      })
      .catch((cause: unknown) => {
        setProviders([]);
        setProvidersError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setProvidersLoading(false));
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  let flowPeers: PeerNode[] = [];
  try {
    // 面板挂在 ReactFlowProvider 内，可直接读取同画布节点；孤立渲染环境（如部分测试）没有 Provider，静默降级
    const flowInstance = useReactFlow();
    flowPeers = flowInstance.getNodes()
      .filter((item) => item.id !== node.id)
      .map((item) => ({
        id: item.id,
        name: typeof item.data['name'] === 'string' ? item.data['name'] as string : undefined,
      }));
  } catch {
    flowPeers = [];
  }
  const peers: PeerNode[] = peerNodes ?? flowPeers;

  /** 全图 {{input.*}} 顶层字段名：Start 面板「运行输入字段」说明区的数据源 */
  const inputFieldNames = useMemo(
    () => (definition ? collectInputFieldNames(definition) : []),
    [definition],
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-auto border-l border-border bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-2xs font-semibold ${meta.color}`}>
          {meta.label}
        </span>
        <code className="text-2xs text-faint">{node.id}</code>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          onClick={() => {
            void confirmDialog({
              title: `删除节点「${data.name}」？`,
              description: '与该节点相连的连线将一并删除，可用 Ctrl+Z 撤销。',
              confirmLabel: '删除',
              danger: true,
            }).then((confirmed) => {
              if (confirmed) onDelete();
            });
          }}
        >
          删除节点
        </Button>
      </header>

      <div className="space-y-3">
        <Field label="节点名称">
          <TextInput value={data.name} onChange={(name) => onChange({ name })} />
        </Field>

        {data.nodeType === 'start' && (
          <>
            <RunInputFieldsBlock fieldNames={inputFieldNames} />
            <Field label="输入 Schema（JSON，可选）" hint="声明运行输入结构，下游用 {{input.xxx}} 引用">
              <JsonField
                value={(data as unknown as StartNodeData).inputSchema ?? {}}
                onChange={(inputSchema) => onChange({ inputSchema })}
                rows={5}
              />
            </Field>
          </>
        )}

        {data.nodeType === 'end' && (
          <FieldBlock label="输出映射" hint="工作流最终输出的字段">
            <TemplateMapEditor
              key={node.id}
              value={((data as unknown as EndNodeData).outputs ?? {}) as Record<string, string>}
              onChange={(outputs) => onChange({ outputs })}
              keyPlaceholder="字段名"
              peers={peers}
            />
          </FieldBlock>
        )}

        {data.nodeType === 'agent' && (
          <AgentForm
            key={node.id}
            data={data as unknown as AgentNodeData}
            onChange={(patch) => onChange(patch as Record<string, unknown>)}
            tools={tools}
            toolsError={toolsError}
            providers={providers}
            providersError={providersError}
            providersLoading={providersLoading}
            onRetryProviders={loadProviders}
            peers={peers}
          />
        )}

        {data.nodeType === 'llm' && (
          <LlmForm
            key={node.id}
            data={data as unknown as LlmNodeData}
            onChange={(patch) => onChange(patch as Record<string, unknown>)}
            providers={providers}
            providersError={providersError}
            providersLoading={providersLoading}
            onRetryProviders={loadProviders}
            peers={peers}
          />
        )}

        {data.nodeType === 'tool' && (
          <ToolForm
            key={node.id}
            data={data as unknown as ToolNodeData}
            onChange={onChange}
            tools={tools}
            toolsError={toolsError}
          />
        )}

        {data.nodeType === 'condition' && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              分支条件
              <span className="ml-1 font-normal text-faint">按表达式命中分支，出边的 sourceHandle 对应分支 id</span>
            </p>
            <ConditionForm
              data={data as unknown as ConditionNodeData}
              onChange={(patch) => onChange(patch as Record<string, unknown>)}
            />
          </div>
        )}

        {data.nodeType === 'loop' && (
          <div className="space-y-3">
            <Field label="最大迭代次数" hint="硬上限，防止失控">
              <NumberInput
                value={(data as unknown as LoopNodeData).maxIterations}
                onChange={(maxIterations) => onChange({ maxIterations })}
                placeholder="5"
              />
            </Field>
            <Field label="迭代集合（模板）" hint="每轮遍历的数组">
              <TextInput
                value={(data as unknown as LoopNodeData).collection ?? ''}
                onChange={(collection) => onChange({ collection })}
                placeholder="{{agent_1.output.items}}"
                mono
              />
            </Field>
            <Field label="迭代变量名" hint="子图内用 {{loop.item}} 引用当前项">
              <TextInput
                value={(data as unknown as LoopNodeData).itemVariable ?? ''}
                onChange={(itemVariable) => onChange({ itemVariable })}
                placeholder="item"
                mono
              />
            </Field>
            <FieldBlock label="子图 JSON（nodes/edges）" hint="循环体在此定义，主图保持 DAG；画布暂不支持可视化编辑">
              <button
                type="button"
                onClick={() => {
                  const subgraph = (data as unknown as LoopNodeData).subgraph;
                  const hasContent = Array.isArray(subgraph?.nodes) && subgraph.nodes.length > 0;
                  if (!hasContent) {
                    onChange({ subgraph: buildSubgraphSkeleton() });
                    return;
                  }
                  void confirmDialog({
                    title: '覆盖已有子图内容？',
                    description: '当前子图将被替换为 start → end 骨架，覆盖后无法恢复。',
                    confirmLabel: '覆盖',
                    danger: true,
                  }).then((confirmed) => {
                    if (confirmed) onChange({ subgraph: buildSubgraphSkeleton() });
                  });
                }}
                className="rounded-md border border-input bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                插入子图骨架（start → end）
              </button>
              <JsonField
                value={
                  (data as unknown as LoopNodeData).subgraph ?? { nodes: [], edges: [] }
                }
                onChange={(subgraph) => onChange({ subgraph })}
                rows={8}
                placeholder='{"nodes":[{"id":"step","type":"llm",...}],"edges":[]}'
              />
            </FieldBlock>
          </div>
        )}

        {data.nodeType === 'human' && (
          <div className="space-y-3">
            <Field label="审批说明" hint="展示给审批人，运行到此挂起等待">
              <TextArea
                value={(data as unknown as HumanNodeData).prompt ?? ''}
                onChange={(prompt) => onChange({ prompt })}
              />
            </Field>
            <Field label="超时（秒，空=无限等待；超时中止暂未实现）">
              <NumberInput
                value={(data as unknown as HumanNodeData).timeoutSeconds}
                onChange={(timeoutSeconds) => onChange({ timeoutSeconds })}
                placeholder="86400"
              />
            </Field>
          </div>
        )}

        {data.nodeType === 'transform' && (
          <FieldBlock label="模板映射" hint="把上游输出重整为本节点的输出结构">
            <TemplateMapEditor
              key={node.id}
              value={
                ((data as unknown as TransformNodeData).template ?? {}) as Record<string, string>
              }
              onChange={(template) => onChange({ template })}
              keyPlaceholder="字段名"
              peers={peers}
            />
          </FieldBlock>
        )}

        {/* 节点级韧性配置：暂存于 data.__nodeExtras，保存时还原为定义顶层字段（见 convert.ts） */}
        {data.nodeType !== 'human' && (
          <details className="rounded-lg border border-border-soft p-2.5">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              高级：超时与重试
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="单次超时 (ms)">
                <NumberInput
                  value={(data.__nodeExtras as { timeoutMs?: number } | undefined)?.timeoutMs}
                  onChange={(timeoutMs) =>
                    onChange({ __nodeExtras: { ...(data.__nodeExtras as object), timeoutMs } })
                  }
                  placeholder="60000"
                />
              </Field>
              <Field label="重试次数上限">
                <NumberInput
                  value={(data.__nodeExtras as { retry?: { maxAttempts?: number } } | undefined)
                    ?.retry?.maxAttempts}
                  onChange={(maxAttempts) =>
                    onChange({
                      __nodeExtras: {
                        ...(data.__nodeExtras as object),
                        retry: maxAttempts === undefined ? undefined : { maxAttempts },
                      },
                    })
                  }
                  placeholder="1（不重试）"
                />
              </Field>
            </div>
            <p className="mt-1 text-2xs text-faint">
              超时未配置时不限制；重试按指数退避（见文档）。
            </p>
          </details>
        )}
      </div>
    </aside>
  );
}
