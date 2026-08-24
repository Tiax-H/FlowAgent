import { useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** 统一按钮风格：primary=主操作（黑）、accent=运行类（蓝）、secondary=次要、dangerOutline=破坏性 */
export function Button({
  variant = 'secondary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'secondary' | 'dangerOutline';
}) {
  const styles: Record<string, string> = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-400',
    accent: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300',
    secondary:
      'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400',
    dangerOutline:
      'border border-neutral-200 bg-white text-neutral-500 hover:border-red-300 hover:text-red-600',
  };
  return (
    <button
      type="button"
      className={`rounded px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

const RUN_STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: { label: '排队中', className: 'border-neutral-300 text-neutral-500' },
  running: { label: '运行中', className: 'border-blue-300 bg-blue-50 text-blue-700' },
  suspended: { label: '已暂停', className: 'border-amber-300 bg-amber-50 text-amber-700' },
  waiting_human: { label: '等待人工', className: 'border-violet-300 bg-violet-50 text-violet-700' },
  completed: { label: '已完成', className: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
  failed: { label: '失败', className: 'border-red-300 bg-red-50 text-red-700' },
  canceled: { label: '已取消', className: 'border-orange-300 bg-orange-50 text-orange-700' },
};

const NODE_STATUS_STYLES: Record<string, { label: string; className: string }> = {
  idle: { label: '待执行', className: 'border-neutral-300 text-neutral-500' },
  running: { label: '运行中', className: 'border-blue-300 bg-blue-50 text-blue-700' },
  succeeded: { label: '成功', className: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
  failed: { label: '失败', className: 'border-red-300 bg-red-50 text-red-700' },
  skipped: { label: '已跳过', className: 'border-neutral-300 bg-neutral-100 text-neutral-500' },
  suspended: { label: '挂起', className: 'border-violet-300 bg-violet-50 text-violet-700' },
};

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}

/** 运行状态徽标（pending/running/suspended/waiting_human/completed/failed/canceled） */
export function RunStatusBadge({ status }: { status: string }) {
  const style = RUN_STATUS_STYLES[status] ?? {
    label: status,
    className: 'border-neutral-300 text-neutral-500',
  };
  return <Badge label={style.label} className={style.className} />;
}

/** 节点状态徽标（idle/running/succeeded/failed/skipped/suspended） */
export function NodeStatusBadge({ status }: { status: string }) {
  const style = NODE_STATUS_STYLES[status] ?? {
    label: status,
    className: 'border-neutral-300 text-neutral-500',
  };
  return <Badge label={style.label} className={style.className} />;
}

/** 模态对话框：Esc 关闭，点击遮罩不关闭（避免误触丢失输入） */
export function Modal({
  title,
  onClose,
  width = 'w-[28rem]',
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  width?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className={`${width} max-h-[85vh] overflow-auto rounded-lg bg-white p-4 shadow-xl`}>
        <h2 className="text-sm font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** 空状态引导块：标题 + 说明 + 可选动作 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
      <p className="text-sm font-medium text-neutral-700">{title}</p>
      {description && (
        <div className="mt-1 text-xs leading-relaxed text-neutral-500">{description}</div>
      )}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

/** 复制到剪贴板按钮，成功后短暂显示"已复制" */
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板 API 不可用（非安全上下文）时退化为选中文本
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="shrink-0 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-700"
    >
      {copied ? '已复制' : label}
    </button>
  );
}

/** 列表加载骨架条 */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-2" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="h-12 animate-pulse rounded-lg border border-neutral-200 bg-neutral-100"
        />
      ))}
    </ul>
  );
}
