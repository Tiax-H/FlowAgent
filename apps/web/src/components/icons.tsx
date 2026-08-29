import type { SVGProps } from 'react';

/**
 * 站点图标唯一来源：内联 SVG，不引入外部图标库。
 * 统一基座：14px、1.75 描边、stroke 继承文字颜色；props 可覆盖任意属性（如 width/height/className）。
 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/** 播放 / 运行（实心三角） */
export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon fill="currentColor" stroke="none" {...props}>
      <path d="M5 3.2v9.6l7.6-4.8L5 3.2Z" />
    </Icon>
  );
}

/** 暂停（两条竖线） */
export function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </Icon>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M4.5 4.5l.55 8.1a1 1 0 0 0 1 .93h3.9a1 1 0 0 0 1-.93l.55-8.1M6.75 7.25v3.5M9.25 7.25v3.5" />
    </Icon>
  );
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" />
    </Icon>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Icon>
  );
}

export function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M13 8H3M7 4L3 8l4 4" />
    </Icon>
  );
}

/** 刷新（双弧箭头） */
export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M2 8a6 6 0 0 1 6-6 6.5 6.5 0 0 1 4.5 1.8L14 5.3M14 2v3.3h-3.3M14 8a6 6 0 0 1-6 6 6.5 6.5 0 0 1-4.5-1.8L2 10.7M5.3 10.7H2v3.3" />
    </Icon>
  );
}

/** 撤销（左折返箭头） */
export function UndoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M6.5 3.5 3 7l3.5 3.5M3 7h6.75a3.25 3.25 0 0 1 0 6.5H7" />
    </Icon>
  );
}

/** 搜索（圆 + 柄） */
export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 13.5 13.5" />
    </Icon>
  );
}

/** 积木块（空状态座图） */
export function BlocksIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="5.5" y="9" width="5" height="5" rx="1" />
    </Icon>
  );
}
