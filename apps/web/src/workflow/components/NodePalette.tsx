import { NODE_TYPE_VALUES, type NodeType } from '@flowagent/shared';

import { NODE_TYPE_META } from '../types';

export const PALETTE_NODE_TYPES = NODE_TYPE_VALUES.filter((type) => type !== 'start' && type !== 'end');

export function NodePalette({ onAdd }: { onAdd: (type: NodeType, position: { x: number; y: number }) => void }) {
  return (
    <aside className="flex w-44 shrink-0 flex-col gap-2 overflow-auto border-r border-neutral-200 bg-white p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">节点</h2>
      {PALETTE_NODE_TYPES.map((type) => {
        const meta = NODE_TYPE_META[type];
        return (
          <button
            key={type}
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/flowagent-node', type);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onAdd(type, { x: 240 + Math.random() * 120, y: 80 + Math.random() * 200 })}
            className="group cursor-grab rounded-lg border border-neutral-200 bg-white p-2 text-left transition-colors hover:border-neutral-400 active:cursor-grabbing"
          >
            <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.color}`}>
              {meta.label}
            </span>
            <p className="mt-1 text-[11px] leading-tight text-neutral-500 group-hover:text-neutral-700">{meta.hint}</p>
          </button>
        );
      })}
      <p className="mt-auto text-[10px] leading-tight text-neutral-400">
        拖拽或点击添加节点；点选节点/连线后按 Delete 删除
      </p>
    </aside>
  );
}
