import { useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { BlocksIcon, CheckIcon } from './icons';

/**
 * 统一按钮风格：primary=主操作（墨色）、accent=运行类（品牌蓝）、secondary=次要、
 * ghost=轻量、danger=破坏性。dangerOutline 为旧名，等价映射到 danger。
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'dangerOutline';
  size?: 'sm' | 'md';
}) {
  const variants: Record<string, string> = {
    primary: 'bg-primary text-primary-foreground hover:bg-sand-11',
    accent: 'bg-accent text-white hover:bg-accent-hover',
    secondary: 'border border-input bg-card text-foreground hover:border-border-strong hover:bg-muted',
    ghost: 'text-muted-foreground hover:bg-muted-strong hover:text-foreground',
    danger: 'border border-transparent text-danger-11 hover:bg-danger-2',
  };
  const sizes: Record<string, string> = {
    sm: 'h-7 px-2.5 text-xs',
    md: '',
  };
  const base =
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';
  return (
    <button
      type="button"
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** 状态徽标语义色：成功 / 失败 / 运行中 / 警示（挂起族）/ 中性 */
export type StatusTone = 'success' | 'danger' | 'running' | 'warning' | 'neutral';

const TONE_BADGE: Record<StatusTone, string> = {
  success: 'bg-success-3 text-success-11',
  danger: 'bg-danger-3 text-danger-11',
  running: 'bg-brand-3 text-brand-11',
  warning: 'bg-warning-3 text-warning-11',
  neutral: 'bg-muted-strong text-muted-foreground',
};

const TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-success-9',
  danger: 'bg-danger-9',
  running: 'bg-brand-9 animate-pulse',
  warning: 'bg-warning-9',
  neutral: 'bg-sand-8',
};

/** 统一状态徽标：胶囊底 + 语义色圆点，所有页面共用 */
export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium ${TONE_BADGE[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
      {label}
    </span>
  );
}

const RUN_STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: '排队中', tone: 'neutral' },
  running: { label: '运行中', tone: 'running' },
  suspended: { label: '已暂停', tone: 'warning' },
  waiting_human: { label: '等待人工', tone: 'warning' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
};

const NODE_STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  idle: { label: '待执行', tone: 'neutral' },
  running: { label: '运行中', tone: 'running' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'neutral' },
  suspended: { label: '挂起', tone: 'warning' },
};

/** 运行状态徽标（pending/running/suspended/waiting_human/completed/failed/canceled） */
export function RunStatusBadge({ status }: { status: string }) {
  const meta = RUN_STATUS_META[status] ?? { label: status, tone: 'neutral' as const };
  return <StatusBadge label={meta.label} tone={meta.tone} />;
}

/** 节点状态徽标（idle/running/succeeded/failed/skipped/suspended） */
export function NodeStatusBadge({ status }: { status: string }) {
  const meta = NODE_STATUS_META[status] ?? { label: status, tone: 'neutral' as const };
  return <StatusBadge label={meta.label} tone={meta.tone} />;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]">
      <div className={`${width} max-h-[85vh] overflow-auto rounded-xl bg-card shadow-lg`}>
        <h2 className="border-b border-border-soft px-5 py-3.5 text-base font-semibold">{title}</h2>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** 空状态引导块：图标座 + 标题 + 说明 + 可选动作 */
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
    <div className="rounded-xl border border-dashed border-border bg-card px-8 py-14 text-center">
      <span
        className="mx-auto grid h-11 w-11 place-items-center rounded-lg bg-muted-strong text-sand-10"
        aria-hidden
      >
        <BlocksIcon width={20} height={20} />
      </span>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      {description && (
        <div className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          {description}
        </div>
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
    <Button variant="ghost" size="sm" className="shrink-0" onClick={() => void copy()}>
      {copied ? (
        <>
          <CheckIcon />
          已复制
        </>
      ) : (
        label
      )}
    </Button>
  );
}

/** 列表加载骨架条 */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-2" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="h-12 animate-pulse rounded-lg border border-border-soft bg-muted"
        />
      ))}
    </ul>
  );
}
