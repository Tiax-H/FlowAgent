import { NODE_TYPE_VALUES, type NodeType } from '@flowagent/shared';

import { NODE_TYPE_META } from '../types';

export const PALETTE_NODE_TYPES = NODE_TYPE_VALUES.filter(
  (type) => type !== 'start' && type !== 'end',
);

export function NodePalette({
  onAdd,
}: {
  onAdd: (type: NodeType, position: { x: number; y: number }) => void;
}) {
  return (
    <aside className="flex w-48 shrink-0 flex-col gap-2 overflow-auto border-r border-border bg-background p-3">
      <h2 className="text-xs font-medium text-muted-foreground">节点</h2>
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
            onClick={() =>
              onAdd(type, { x: 240 + Math.random() * 120, y: 80 + Math.random() * 200 })
            }
            className="group cursor-grab rounded-lg border border-border-soft bg-card p-2.5 text-left shadow-xs transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-sm active:cursor-grabbing"
          >
            <span className={`inline-block rounded px-1.5 py-0.5 text-2xs font-semibold ${meta.color}`}>
              {meta.label}
            </span>
            <p className="mt-1 text-2xs leading-tight text-muted-foreground group-hover:text-foreground">
              {meta.hint}
            </p>
          </button>
        );
      })}
      <div className="mt-auto space-y-1 text-2xs leading-tight text-faint">
        <p>拖拽或点击添加节点；点选节点/连线后按 Delete 删除</p>
        <p>任务内容在点『运行』后的输入框中填写，节点提示词用 {'{{input.xxx}}'} 引用</p>
      </div>
    </aside>
  );
}
