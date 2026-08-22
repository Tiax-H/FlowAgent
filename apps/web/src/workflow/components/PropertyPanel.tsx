import { useEffect, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
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
} from '@flowagent/shared';

import { mcpApi, type McpTool } from '../../api/mcp';
import { NODE_TYPE_META } from '../types';

interface PropertyPanelProps {
  node: Node;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}

interface NodeDataShape extends Record<string, unknown> {
  nodeType: NodeType;
  name: string;
  __nodeExtras?: { timeoutMs?: number; retry?: { maxAttempts?: number } };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none';

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
        className={`${inputClass} font-mono text-xs ${invalid ? 'border-red-400 bg-red-50' : ''}`}
      />
      {invalid && <p className="mt-1 text-[10px] text-red-500">JSON 格式暂不合法，修正后生效</p>}
    </div>
  );
}

function TextArea(props: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <textarea
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      className={`${inputClass} ${props.mono ? 'font-mono text-xs' : ''}`}
    />
  );
}

/** 键→模板 映射编辑（End.outputs / Transform.template 共用） */
function TemplateMapEditor({
  value,
  onChange,
  keyPlaceholder,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  keyPlaceholder: string;
}) {
  const entries = Object.entries(value);

  /** 保序更新：按原顺序重建，避免重命名字段时行跳位 */
  const rebuild = (updated: Array<[string, string]>): Record<string, string> => {
    const next: Record<string, string> = {};
    for (const [key, template] of updated) {
      if (key === '') continue;
      next[key] = template;
    }
    return next;
  };

  return (
    <div className="space-y-1">
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
            className="w-24 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <input
            value={template}
            onChange={(event) => {
              const next = { ...value };
              next[key] = event.target.value;
              onChange(next);
            }}
            placeholder="{{node_x.output}}"
            className="flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
            className="rounded border border-red-200 px-2 text-xs text-red-500 hover:bg-red-50"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          if (entries.some(([key]) => key === '')) return;
          onChange({ ...value, '': '' });
        }}
        className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
      >
        + 添加字段
      </button>
    </div>
  );
}

function AgentForm({
  data,
  onChange,
  tools,
  toolsError,
}: {
  data: AgentNodeData;
  onChange: (patch: Partial<AgentNodeData>) => void;
  tools: McpTool[];
  toolsError: string | null;
}) {
  const bound: McpToolBinding[] = data.tools ?? [];
  return (
    <div className="space-y-3">
      <Field label="Provider">
        <TextInput
          value={data.provider ?? ''}
          onChange={(provider) => onChange({ provider })}
          placeholder="openai / aggregator"
        />
      </Field>
      <Field label="模型">
        <TextInput
          value={data.model ?? ''}
          onChange={(model) => onChange({ model })}
          placeholder="deepseek-chat"
        />
      </Field>
      <Field label="System Prompt">
        <TextArea
          value={data.systemPrompt ?? ''}
          onChange={(systemPrompt) => onChange({ systemPrompt })}
        />
      </Field>
      <Field label="提示词（支持 {{node.output}} 模板）">
        <TextArea value={data.prompt ?? ''} onChange={(prompt) => onChange({ prompt })} />
      </Field>
      <Field label="绑定 MCP 工具">
        {tools.length === 0 ? (
          toolsError ? (<p className="text-xs text-red-500">工具列表加载失败：{toolsError}</p>) : (<p className="text-xs text-neutral-400">注册表为空，请先在 MCP Servers 页添加</p>)
        ) : (
          <div className="max-h-40 space-y-1 overflow-auto rounded border border-neutral-200 p-2">
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
                  />
                  <code className="text-[11px]">{tool.qualifiedName}</code>
                </label>
              );
            })}
          </div>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="最大轮数">
          <NumberInput
            value={data.maxIterations}
            onChange={(maxIterations) => onChange({ maxIterations })}
            placeholder="8"
          />
        </Field>
        <Field label="Temperature">
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
        <div key={index} className="space-y-1 rounded border border-neutral-200 p-2">
          <div className="flex gap-1">
            <input
              value={branch.id}
              onChange={(event) => {
                const next = [...branches];
                if (next[index]) next[index] = { ...branch, id: event.target.value };
                onChange({ branches: next });
              }}
              placeholder="分支 id（sourceHandle）"
              className="w-32 rounded border border-neutral-300 px-2 py-1 font-mono text-xs"
            />
            <input
              value={branch.label ?? ''}
              onChange={(event) => {
                const next = [...branches];
                if (next[index]) next[index] = { ...branch, label: event.target.value };
                onChange({ branches: next });
              }}
              placeholder="显示名（可选）"
              className="flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => onChange({ branches: branches.filter((_, i) => i !== index) })}
              className="rounded border border-red-200 px-2 text-xs text-red-500 hover:bg-red-50"
            >
              ×
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
            className="w-full rounded border border-neutral-300 px-2 py-1 font-mono text-xs"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            branches: [...branches, { id: `branch_${branches.length + 1}`, expression: 'true' }],
          })
        }
        className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
      >
        + 添加分支
      </button>
    </div>
  );
}

export function PropertyPanel({ node, onChange, onDelete }: PropertyPanelProps) {
  const data = node.data as NodeDataShape;
  const meta = NODE_TYPE_META[data.nodeType];
  const [tools, setTools] = useState<McpTool[]>([]);
  const [toolsError, setToolsError] = useState<string | null>(null);

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

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-auto border-l border-neutral-200 bg-white p-3">
      <header className="mb-3 flex items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.color}`}>
          {meta.label}
        </span>
        <code className="text-[10px] text-neutral-400">{node.id}</code>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`删除节点「${data.name}」及其连线？`)) onDelete();
          }}
          className="ml-auto rounded border border-red-200 px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
        >
          删除节点
        </button>
      </header>

      <div className="space-y-3">
        <Field label="节点名称">
          <TextInput value={data.name} onChange={(name) => onChange({ name })} />
        </Field>

        {data.nodeType === 'start' && (
          <Field label="输入 Schema（JSON，可选）">
            <JsonField
              value={(data as unknown as StartNodeData).inputSchema ?? {}}
              onChange={(inputSchema) => onChange({ inputSchema })}
              rows={5}
            />
          </Field>
        )}

        {data.nodeType === 'end' && (
          <Field label="输出映射">
            <TemplateMapEditor
              value={((data as unknown as EndNodeData).outputs ?? {}) as Record<string, string>}
              onChange={(outputs) => onChange({ outputs })}
              keyPlaceholder="字段名"
            />
          </Field>
        )}

        {data.nodeType === 'agent' && (
          <AgentForm
            data={data as unknown as AgentNodeData}
            onChange={(patch) => onChange(patch as Record<string, unknown>)}
            tools={tools}
            toolsError={toolsError}
          />
        )}

        {data.nodeType === 'llm' && (
          <div className="space-y-3">
            <Field label="Provider">
              <TextInput
                value={(data as unknown as LlmNodeData).provider ?? ''}
                onChange={(provider) => onChange({ provider })}
              />
            </Field>
            <Field label="模型">
              <TextInput
                value={(data as unknown as LlmNodeData).model ?? ''}
                onChange={(model) => onChange({ model })}
              />
            </Field>
            <Field label="提示词">
              <TextArea
                value={(data as unknown as LlmNodeData).prompt ?? ''}
                onChange={(prompt) => onChange({ prompt })}
              />
            </Field>
            <Field label="Temperature">
              <NumberInput
                value={(data as unknown as LlmNodeData).temperature}
                onChange={(temperature) => onChange({ temperature })}
                placeholder="0.7"
              />
            </Field>
          </div>
        )}

        {data.nodeType === 'tool' && (
          <div className="space-y-3">
            <Field label="选择 MCP 工具">
              {tools.length === 0 ? (
                toolsError ? (<p className="text-xs text-red-500">工具列表加载失败：{toolsError}</p>) : (<p className="text-xs text-neutral-400">注册表为空，请先在 MCP Servers 页添加</p>)
              ) : (
                <select
                  value={`${(data as unknown as ToolNodeData).server ?? ''}:${(data as unknown as ToolNodeData).tool ?? ''}`}
                  onChange={(event) => {
                    const [server, tool] = event.target.value.split(':');
                    onChange({ server, tool });
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
            <Field label="参数 JSON（值支持模板）">
              <JsonField
                value={(data as unknown as ToolNodeData).args ?? {}}
                onChange={(args) => onChange({ args })}
                rows={4}
              />
            </Field>
            <Field label="超时 (ms)">
              <NumberInput
                value={(data as unknown as ToolNodeData).timeoutMs}
                onChange={(timeoutMs) => onChange({ timeoutMs })}
                placeholder="30000"
              />
            </Field>
          </div>
        )}

        {data.nodeType === 'condition' && (
          <ConditionForm
            data={data as unknown as ConditionNodeData}
            onChange={(patch) => onChange(patch as Record<string, unknown>)}
          />
        )}

        {data.nodeType === 'loop' && (
          <div className="space-y-3">
            <Field label="最大迭代次数">
              <NumberInput
                value={(data as unknown as LoopNodeData).maxIterations}
                onChange={(maxIterations) => onChange({ maxIterations })}
                placeholder="5"
              />
            </Field>
            <Field label="迭代集合（模板）">
              <TextInput
                value={(data as unknown as LoopNodeData).collection ?? ''}
                onChange={(collection) => onChange({ collection })}
                placeholder="{{agent_1.output.items}}"
                mono
              />
            </Field>
            <Field label="迭代变量名">
              <TextInput
                value={(data as unknown as LoopNodeData).itemVariable ?? ''}
                onChange={(itemVariable) => onChange({ itemVariable })}
                placeholder="item"
                mono
              />
            </Field>
            <Field label="子图 JSON（nodes/edges，画布暂不支持可视化编辑）">
              <JsonField
                value={
                  (data as unknown as LoopNodeData).subgraph ?? { nodes: [], edges: [] }
                }
                onChange={(subgraph) => onChange({ subgraph })}
                rows={8}
                placeholder='{"nodes":[{"id":"step","type":"llm",...}],"edges":[]}'
              />
            </Field>
          </div>
        )}

        {data.nodeType === 'human' && (
          <div className="space-y-3">
            <Field label="审批说明">
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
          <Field label="模板映射">
            <TemplateMapEditor
              value={
                ((data as unknown as TransformNodeData).template ?? {}) as Record<string, string>
              }
              onChange={(template) => onChange({ template })}
              keyPlaceholder="字段名"
            />
          </Field>
        )}

        {/* 节点级韧性配置：暂存于 data.__nodeExtras，保存时还原为定义顶层字段（见 convert.ts） */}
        {data.nodeType !== 'human' && (
          <details className="rounded border border-neutral-200 p-2">
            <summary className="cursor-pointer text-xs font-medium text-neutral-500">
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
            <p className="mt-1 text-[10px] text-neutral-400">
              超时未配置时不限制；重试按指数退避（见文档）。
            </p>
          </details>
        )}
      </div>
    </aside>
  );
}
