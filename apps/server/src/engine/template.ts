/**
 * 模板引擎：`{{expr}}` 占位符渲染。
 *
 * 上下文：input.* / variables.* / node 输出（顶层，按节点 id）
 * Loop 迭代体内额外暴露 loop.item / loop.index。
 * 非字符串占位符返回原值（支持整对象插值），路径不解析时返回 null。
 */

export interface TemplateContext {
  input: unknown;
  variables: Record<string, unknown>;
  /** 各已完成节点的输出，按节点 id 索引；Loop 内含前几轮输出 */
  nodeOutputs: Record<string, unknown>;
  loop?: { item: unknown; index: number };
}

const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;

/** 解析点分路径；支持数字索引访问数组；未命中返回 undefined */
export function resolvePath(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    const container = current as Record<string, unknown>;
    if (Array.isArray(current)) {
      if (segment === 'length') {
        current = current.length;
      } else {
        const index = Number(segment);
        if (!Number.isInteger(index)) return undefined;
        current = current[index];
      }
    } else if (segment in container) {
      current = container[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** 解析单个表达式：input.x / variables.y / loop.item / node_id.path */
export function resolveTemplateExpression(expression: string, context: TemplateContext): unknown {
  const trimmed = expression.trim();
  const firstDot = trimmed.indexOf('.');
  const head = firstDot === -1 ? trimmed : trimmed.slice(0, firstDot);
  const restSegments = firstDot === -1 ? [] : trimmed.slice(firstDot + 1).split('.');

  if (head === 'input') return resolvePath(context.input, restSegments);
  if (head === 'variables') return resolvePath(context.variables, restSegments);
  if (head === 'loop') {
    if (restSegments.length === 0) return context.loop ?? undefined;
    if (restSegments[0] === 'item') return resolvePath(context.loop?.item, restSegments.slice(1));
    if (restSegments[0] === 'index') return context.loop?.index;
    return resolvePath(context.loop, restSegments);
  }
  // 节点输出：node_id 或 node_id.path
  if (head in context.nodeOutputs) {
    return resolvePath(context.nodeOutputs[head], restSegments);
  }
  return undefined;
}

/** 渲染字符串模板：混合文本做字符串插值；整体单个占位符保留原类型 */
export function renderTemplate(template: string, context: TemplateContext): unknown {
  const wholeMatch = /^\{\{([^}]+)\}\}$/.exec(template.trim());
  if (wholeMatch) {
    const value = resolveTemplateExpression(wholeMatch[1] ?? '', context);
    return value === undefined ? null : value;
  }

  return template.replace(TEMPLATE_PATTERN, (_match, expression: string) => {
    const value = resolveTemplateExpression(expression, context);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** 递归渲染对象/数组里的所有字符串模板 */
export function renderDeep<T>(value: T, context: TemplateContext): unknown {
  if (typeof value === 'string') return renderTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, context));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = renderDeep(item, context);
    }
    return result;
  }
  return value;
}
