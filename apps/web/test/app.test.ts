import { describe, expect, it } from 'vitest';

import { App } from '../src/App';

describe('App', () => {
  it('是可渲染的 React 组件函数', () => {
    expect(typeof App).toBe('function');
    expect(App.name).toBe('App');
  });
});
