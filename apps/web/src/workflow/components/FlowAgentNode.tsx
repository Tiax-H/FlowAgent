import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ConditionBranch, McpToolBinding } from '@flowagent/shared';
import type { NodeType } from '../types';
import { NODE_TYPE_META } from '../types';

interface FlowAgentNodeData extends Record<string, unknown> {
  nodeType: NodeType;
  name: string;
  branches?: ConditionBranch[];
  /** Agent/LLM 节点：模型绑定（definition 里已有，画布上直接可见） */
  provider?: string;
  model?: string;
  /** Agent 节点：绑定的 MCP 工具 */
  tools?: McpToolBinding[];
  /** Tool 节点：直调的 MCP 工具 */
  server?: string;
  tool?: string;
}

export function FlowAgentNode({ data, selected }: NodeProps<Node<FlowAgentNodeData, 'flowagent'>>) {
  const meta = NODE_TYPE_META[data.nodeType];
  const branches = data.nodeType === 'condition' ? (data.branches ?? []) : [];
  const isModelNode = data.nodeType === 'agent' || data.nodeType === 'llm';
  const provider = typeof data.provider === 'string' ? data.provider.trim() : '';
  const model = typeof data.model === 'string' ? data.model.trim() : '';
  const toolCount =
    data.nodeType === 'agent' && Array.isArray(data.tools)
      ? data.tools.filter((item) => item && typeof item.server === 'string').length
      : 0;

  return (
    <div
      className={`min-w-[160px] max-w-[220px] rounded-lg border bg-card px-3 py-2.5 shadow-xs transition-[border-color,box-shadow] ${
        selected
          ? 'border-brand-8 shadow-md ring-[3px] ring-brand-6/30'
          : 'border-border hover:border-border-strong hover:shadow-sm'
      }`}
    >
      {data.nodeType !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-2xs font-semibold ${meta.color}`}>
          {meta.label}
        </span>
        {toolCount > 0 && (
          <span
            title={`已绑定 ${toolCount} 个 MCP 工具`}
            className="ml-auto shrink-0 rounded bg-amber-50 px-1 py-0.5 font-mono text-2xs text-amber-700"
          >
            {toolCount} 工具
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-sm font-medium">{data.name || meta.label}</p>
      {isModelNode &&
        (provider ? (
          <p className="mt-0.5 truncate font-mono text-2xs text-faint" title={`${provider} / ${model}`}>
            {provider}
            {model ? ` / ${model}` : ''}
          </p>
        ) : (
          <p className="mt-0.5 text-2xs text-warning-11">未配置模型</p>
        ))}
      {data.nodeType === 'tool' && data.server && (
        <p className="mt-0.5 truncate font-mono text-2xs text-faint">
          {data.server}:{data.tool ?? ''}
        </p>
      )}
      {branches.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {branches.map((branch) => (
            <li key={branch.id} className="flex items-center gap-1 text-2xs text-muted-foreground">
              <span className="font-mono">{branch.id}</span>
              <span className="truncate">{branch.label ?? branch.expression}</span>
            </li>
          ))}
        </ul>
      )}
      {data.nodeType !== 'end' &&
        (branches.length > 0 ? (
          // 每个分支一个 source handle：按分支行等分节点高度定位，
          // 避免多个 handle 全部叠在节点右缘垂直中点、连线无法分辨
          branches.map((branch, index) => (
            <Handle
              key={branch.id}
              id={branch.id}
              type="source"
              position={Position.Right}
              style={{ top: `${((index + 1) / (branches.length + 1)) * 100}%` }}
            />
          ))
        ) : (
          <Handle type="source" position={Position.Right} />
        ))}
    </div>
  );
}
