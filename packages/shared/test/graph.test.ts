import { describe, expect, it } from 'vitest';

import { detectCycle, findUnreachableNodes } from '../src/graph';

describe('detectCycle', () => {
  it('线性图无环', () => {
    const cycle = detectCycle(
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    );
    expect(cycle).toBeNull();
  });

  it('检测两节点环', () => {
    const cycle = detectCycle(
      ['a', 'b'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    );
    expect(cycle).toEqual(['a', 'b', 'a']);
  });

  it('检测自环', () => {
    const cycle = detectCycle(['a'], [{ source: 'a', target: 'a' }]);
    expect(cycle).toEqual(['a', 'a']);
  });

  it('检测长环并返回完整路径', () => {
    const cycle = detectCycle(
      ['a', 'b', 'c', 'd'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'd' },
        { source: 'd', target: 'b' },
      ],
    );
    expect(cycle).toEqual(['b', 'c', 'd', 'b']);
  });

  it('分叉汇聚的菱形无环', () => {
    const cycle = detectCycle(
      ['a', 'b', 'c', 'd'],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    );
    expect(cycle).toBeNull();
  });

  it('孤立节点不构成环', () => {
    const cycle = detectCycle(['a', 'b', 'isolated'], [{ source: 'a', target: 'b' }]);
    expect(cycle).toBeNull();
  });
});

describe('findUnreachableNodes', () => {
  it('全部可达时返回空', () => {
    const unreachable = findUnreachableNodes(
      'a',
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    );
    expect(unreachable).toEqual([]);
  });

  it('返回不可达节点', () => {
    const unreachable = findUnreachableNodes(
      'a',
      ['a', 'b', 'orphan1', 'orphan2'],
      [{ source: 'a', target: 'b' }],
    );
    expect(unreachable).toEqual(['orphan1', 'orphan2']);
  });
});
