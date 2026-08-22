/**
 * WorkflowDefinition 运行时校验：JSON Schema + 结构性规则（DAG、连通、引用完整）。
 *
 * API 保存工作流与前端画布保存共用此入口，保证两端口径一致。
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

import { detectCycle, findUnreachableNodes } from './graph';
import { workflowJsonSchema } from './schema';
import { SCHEMA_VERSION } from './workflow';

export interface WorkflowValidationResult {
  valid: boolean;
  /** 人类可读的错误描述（含 JSON 路径），供 API 422 响应与画布提示共用 */
  errors: string[];
}

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true });
    cachedValidator = ajv.compile(workflowJsonSchema);
  }
  return cachedValidator;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((error) => {
    const path = error.instancePath || '(根)';
    return `${path}: ${translateAjvMessage(error)}`;
  });
}

/** 常见 Ajv 错误的中文映射（未命中回落英文原文，保证信息不丢） */
function translateAjvMessage(error: ErrorObject): string {
  switch (error.keyword) {
    case 'required':
      return `缺少必填字段: ${(error.params as { missingProperty?: string }).missingProperty ?? ''}`;
    case 'type':
      return `字段类型应为 ${String((error.params as { type?: string }).type ?? '')}`;
    case 'minLength':
      return `长度不能少于 ${String((error.params as { limit?: number }).limit ?? '')} 个字符`;
    case 'maxLength':
      return `长度不能超过 ${String((error.params as { limit?: number }).limit ?? '')} 个字符`;
    case 'minItems':
      return `至少需要 ${String((error.params as { limit?: number }).limit ?? '')} 项`;
    case 'additionalProperties':
      return `存在未定义的字段: ${String((error.params as { additionalProperty?: string }).additionalProperty ?? '')}`;
    case 'enum':
      return `取值必须是 ${(error.params as { allowedValues?: unknown[] }).allowedValues?.join(' / ') ?? '合法枚举值'} 之一`;
    default:
      return error.message ?? '校验失败';
  }
}

interface MinimalNode {
  id: string;
  type: string;
  name?: string;
  data?: Record<string, unknown>;
}

interface MinimalEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

/** 节点级 data 校验：坏配置在保存时就报人话，而不是运行时才炸 */
function validateNodeData(nodes: MinimalNode[], errors: string[]): void {
  const requireString = (node: MinimalNode, field: string): boolean => {
    const value = node.data?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`节点 "${node.id}"（${node.type}）缺少 ${field} 配置`);
      return false;
    }
    return true;
  };

  for (const node of nodes) {
    switch (node.type) {
      case 'llm':
        requireString(node, 'provider');
        requireString(node, 'model');
        requireString(node, 'prompt');
        break;
      case 'agent':
        requireString(node, 'provider');
        requireString(node, 'model');
        break;
      case 'tool':
        requireString(node, 'server');
        requireString(node, 'tool');
        break;
      case 'transform': {
        const template = node.data?.template;
        if (
          typeof template !== 'object' ||
          template === null ||
          Array.isArray(template) ||
          Object.keys(template).length === 0
        ) {
          errors.push(`节点 "${node.id}"（transform）需要非空的 template 映射`);
        }
        break;
      }
      case 'loop':
        validateLoopNode(node, errors);
        break;
      default:
        break;
    }
  }
}

/** Loop 子图校验：必须有 subgraph、子图自身是 DAG、边引用完整（环上节点会被静默丢弃，必须在保存时拦截） */
function validateLoopNode(node: MinimalNode, errors: string[]): void {
  const data = node.data ?? {};
  const maxIterations = data.maxIterations;
  if (typeof maxIterations !== 'number' || maxIterations < 1) {
    errors.push(`节点 "${node.id}"（loop）的 maxIterations 必须是 >= 1 的数字`);
  }
  if (typeof data.collection !== 'string' || (data.collection as string).trim().length === 0) {
    errors.push(`节点 "${node.id}"（loop）缺少 collection 迭代集合配置`);
  }
  const subgraph = data.subgraph as
    | { nodes?: MinimalNode[]; edges?: MinimalEdge[] }
    | undefined;
  if (
    !subgraph ||
    typeof subgraph !== 'object' ||
    !Array.isArray(subgraph.nodes) ||
    subgraph.nodes.length === 0
  ) {
    errors.push(
      `Loop 节点 "${node.id}" 缺少迭代子图（subgraph）：请在属性面板的「子图 JSON」中配置，画布暂不支持子图可视化编辑`,
    );
    return;
  }
  const subNodes = subgraph.nodes;
  const subEdges = Array.isArray(subgraph.edges) ? subgraph.edges : [];
  const subIds = subNodes.map((item) => item.id);
  for (const edge of subEdges) {
    if (!subIds.includes(edge.source)) {
      errors.push(`Loop 节点 "${node.id}" 子图边 "${edge.id}" 的 source 不存在: "${edge.source}"`);
    }
    if (!subIds.includes(edge.target)) {
      errors.push(`Loop 节点 "${node.id}" 子图边 "${edge.id}" 的 target 不存在: "${edge.target}"`);
    }
  }
  const validSubEdges = subEdges.filter(
    (edge) => subIds.includes(edge.source) && subIds.includes(edge.target),
  );
  const subCycle = detectCycle(subIds, validSubEdges);
  if (subCycle) {
    errors.push(`Loop 节点 "${node.id}" 的子图必须为 DAG，检测到环: ${subCycle.join(' → ')}`);
  }
  // 递归校验子图内的节点 data（子图可再嵌 Loop）
  validateNodeData(subNodes, errors);
}

/** 校验任意输入是否为合法的 WorkflowDefinition */
export function validateWorkflowDefinition(input: unknown): WorkflowValidationResult {
  const errors: string[] = [];

  const validator = getValidator();
  if (!validator(input)) {
    errors.push(...formatSchemaErrors(validator.errors));
    return { valid: false, errors };
  }

  const definition = input as {
    nodes: Array<{ id: string; type: string; data?: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; target: string; sourceHandle?: string }>;
  };

  const nodes = definition.nodes;
  const edges = definition.edges;  const nodeIds = nodes.map((node) => node.id);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) errors.push(`节点 id 重复: "${node.id}"`);
    seen.add(node.id);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

  for (const edge of edges) {
    if (!nodeById.has(edge.source))
      errors.push(`边 "${edge.id}" 的 source 不存在: "${edge.source}"`);
    if (!nodeById.has(edge.target))
      errors.push(`边 "${edge.id}" 的 target 不存在: "${edge.target}"`);
  }

  const startNodes = nodes.filter((node) => node.type === 'start');
  const endNodes = nodes.filter((node) => node.type === 'end');
  if (startNodes.length === 0) errors.push('必须恰好一个 start 节点，当前为 0 个');
  if (startNodes.length > 1) {
    errors.push(`必须恰好一个 start 节点，当前为 ${startNodes.length} 个`);
  }
  if (endNodes.length === 0) errors.push('至少需要一个 end 节点');

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    if (!source) continue;
    if (source.type === 'condition') {
      if (!edge.sourceHandle) {
        errors.push(
          `Condition 节点 "${source.id}" 的出边 "${edge.id}" 必须指定 sourceHandle（分支 id）`,
        );
        continue;
      }
      const branches = (source.data?.branches ?? []) as Array<{ id?: unknown }>;
      if (!branches.some((branch) => branch.id === edge.sourceHandle)) {
        errors.push(
          `边 "${edge.id}" 的 sourceHandle "${edge.sourceHandle}" 不属于 Condition 节点 "${source.id}" 的任何分支`,
        );
      }
    } else if (edge.sourceHandle) {
      errors.push(`非 Condition 节点 "${source.id}" 的出边 "${edge.id}" 不应携带 sourceHandle`);
    }
  }

  for (const node of nodes) {
    if (node.type !== 'condition') continue;
    const branches = (node.data?.branches ?? []) as Array<{ id?: unknown; expression?: unknown }>;
    if (branches.length === 0) {
      errors.push(`Condition 节点 "${node.id}" 至少需要一个分支`);
      continue;
    }
    const branchIds = new Set<string>();
    for (const branch of branches) {
      if (typeof branch.id !== 'string' || branch.id.length === 0) {
        errors.push(`Condition 节点 "${node.id}" 存在缺少 id 的分支`);
      } else if (branchIds.has(branch.id)) {
        errors.push(`Condition 节点 "${node.id}" 分支 id 重复: "${branch.id}"`);
      } else {
        branchIds.add(branch.id);
      }
      if (typeof branch.expression !== 'string' || branch.expression.trim().length === 0) {
        errors.push(`Condition 节点 "${node.id}" 存在表达式为空的分支`);
      }
    }
  }

  const validEdges = edges.filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target));
  const cycle = detectCycle(nodeIds, validEdges);
  if (cycle) {
    errors.push(`主图必须为严格 DAG，检测到环: ${cycle.join(' → ')}`);
  }

  const startId = startNodes[0]?.id;
  if (startId) {
    const unreachable = findUnreachableNodes(startId, nodeIds, validEdges);
    if (unreachable.length > 0) {
      errors.push(`存在从 start 不可达的节点: ${unreachable.map((id) => `"${id}"`).join(', ')}`);
    }
  }

  // 节点级 data 校验（含 Loop 子图 DAG/引用校验）
  validateNodeData(nodes, errors);

  return { valid: errors.length === 0, errors };
}

export { SCHEMA_VERSION };
