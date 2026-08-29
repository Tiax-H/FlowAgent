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
      className={`min-w-[140px] max-w-[220px] rounded-lg border-2 bg-white px-3 py-2 shadow-sm transition-shadow ${
        selected ? 'border-neutral-900 shadow-md' : 'border-neutral-200'
      }`}
    >
      {data.nodeType !== 'start' && (
        <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-neutral-400" />
      )}
      <div className="flex items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.color}`}>
          {meta.label}
        </span>
        {toolCount > 0 && (
          <span
            title={`已绑定 ${toolCount} 个 MCP 工具`}
            className="ml-auto shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700"
          >
            🔧 {toolCount}
          </span>
        )}
      </div>
      <p className="mt-1 truncate text-sm font-medium text-neutral-800">
        {data.name || meta.label}
      </p>
      {isModelNode &&
        (provider ? (
          <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500" title={`${provider} / ${model}`}>
            {provider}
            {model ? ` / ${model}` : ''}
          </p>
        ) : (
          <p className="mt-0.5 text-[10px] text-amber-600">未配置模型</p>
        ))}
      {data.nodeType === 'tool' && data.server && (
        <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
          {data.server}:{data.tool ?? ''}
        </p>
      )}
      {branches.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {branches.map((branch) => (
            <li key={branch.id} className="flex items-center gap-1 text-[10px] text-neutral-500">
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
              className="!h-2.5 !w-2.5 !bg-orange-400"
              style={{ top: `${((index + 1) / (branches.length + 1)) * 100}%` }}
            />
          ))
        ) : (
          <Handle
            type="source"
            position={Position.Right}
            className="!h-2.5 !w-2.5 !bg-neutral-400"
          />
        ))}
    </div>
  );
}
