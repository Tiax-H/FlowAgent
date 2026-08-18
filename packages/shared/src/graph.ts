/**
 * 主图结构工具：环检测与可达性。
 *
 * 架构红线：主图必须是严格 DAG，循环语义只存在于 Loop 节点（子图迭代）。
 * 画布保存前与本包的 `validateWorkflowDefinition` 都必须调用环检测。
 */

export interface GraphEdge {
  source: string;
  target: string;
}

type NodeState = 'unvisited' | 'visiting' | 'done';

/**
 * 迭代三色 DFS 环检测。
 * @returns 存在环时返回环上的节点 id 路径（首尾相同，如 `['a','b','c','a']`），否则 `null`
 */
export function detectCycle(nodeIds: string[], edges: GraphEdge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    const targets = adjacency.get(edge.source);
    if (targets) targets.push(edge.target);
  }

  const state = new Map<string, NodeState>();
  for (const id of nodeIds) state.set(id, 'unvisited');

  for (const start of nodeIds) {
    if (state.get(start) !== 'unvisited') continue;

    const stack: Array<{ node: string; edgeIndex: number; path: string[] }> = [
      { node: start, edgeIndex: 0, path: [start] },
    ];
    state.set(start, 'visiting');

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const neighbors = adjacency.get(top.node) ?? [];

      if (top.edgeIndex >= neighbors.length) {
        state.set(top.node, 'done');
        stack.pop();
        continue;
      }

      const next = neighbors[top.edgeIndex];
      top.edgeIndex += 1;
      if (next === undefined) continue;

      const nextState = state.get(next);
      if (nextState === 'visiting') {
        const path = [...top.path, next];
        const cycleStart = path.indexOf(next);
        return path.slice(cycleStart === -1 ? 0 : cycleStart);
      }
      if (nextState === 'unvisited') {
        state.set(next, 'visiting');
        stack.push({ node: next, edgeIndex: 0, path: [...top.path, next] });
      }
    }
  }

  return null;
}

/** 返回从 `startId` 出发无法到达的节点 id 列表（不含自身） */
export function findUnreachableNodes(
  startId: string,
  nodeIds: string[],
  edges: GraphEdge[],
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    const targets = adjacency.get(edge.source);
    if (targets) targets.push(edge.target);
  }

  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return nodeIds.filter((id) => id !== startId && !visited.has(id));
}
