/**
 * Condition 表达式安全求值：expr-eval 负责运算符逻辑，绝不 eval。
 *
 * expr-eval 只支持两层成员访问，因此深层点分路径先由本模块解析为字面量再内联；
 * 支持 && / ||（自动转译为 expr-eval 的 and / or）。
 */
import { Expression, Parser } from 'expr-eval';

import { resolvePath, type TemplateContext } from './template';

export type ExpressionContext = TemplateContext;

const parser = new Parser();

/** 根作用域查找：input / variables / 节点输出顶层 */
function lookupRoot(name: string, context: ExpressionContext): { found: boolean; value: unknown } {
  if (name === 'input') return { found: true, value: context.input };
  if (name === 'variables') return { found: true, value: context.variables };
  if (name in context.nodeOutputs) return { found: true, value: context.nodeOutputs[name] };
  return { found: false, value: undefined };
}

const DOTTED_PATH_PATTERN = /[a-zA-Z_$][\w$]*(?:\.[\w$]+)+/g;

/** 路径解析（含数组 length 支持） */
function resolveWithLength(root: unknown, segments: string[]): unknown {
  if (segments.length === 1 && segments[0] === 'length' && Array.isArray(root)) return root.length;
  return resolvePath(root, segments);
}

export function evaluateCondition(expression: string, context: ExpressionContext): unknown {
  // 1. 转译逻辑运算符
  let normalized = expression.replace(/&&/g, ' and ').replace(/\|\|/g, ' or ');

  // 2. 深层点分路径 → 字面量内联（含两层以上；两层以下也统一处理，绕开 expr-eval 成员访问限制）
  normalized = normalized.replace(DOTTED_PATH_PATTERN, (path) => {
    const firstDot = path.indexOf('.');
    const head = path.slice(0, firstDot);
    const segments = path.slice(firstDot + 1).split('.');
    const root = lookupRoot(head, context);
    if (!root.found) return path; // 未知名留给 parser 报错
    const value = resolveWithLength(root.value, segments);
    if (value === undefined) return 'undefined';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });

  // 3. 解析
  let compiled: Expression;
  try {
    compiled = parser.parse(normalized);
  } catch (error) {
    throw new Error(`表达式语法错误 "${expression}": ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4. 求值（顶层名：input/variables/节点 id；未知名会抛错，不静默通过）
  const scope: Record<string, unknown> = {
    input: context.input,
    variables: context.variables,
    ...context.nodeOutputs,
  };
  try {
    return compiled.evaluate(scope as Record<string, never>);
  } catch (error) {
    throw new Error(
      `表达式求值失败 "${expression}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}
