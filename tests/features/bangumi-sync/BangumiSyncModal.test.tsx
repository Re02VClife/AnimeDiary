/**
 * BangumiSyncModal 的渲染冒烟测试。
 *
 * 逻辑都在 core 里单测过了；这里只保证「打开面板不会崩」——
 * 空数据 / 未登录状态下，antd 的 Modal + Tabs + Table 组合只有在真实渲染时
 * 才会暴露问题（空 dataSource、缺失的 matchMedia 等）。
 *
 * 用 react-dom/client 手动渲染而不是 @testing-library/react：
 * 项目没装那个包，为一个冒烟测试加依赖不划算。
 */
import React, { act } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  (globalThis as any).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * animeList 必须是一个**稳定引用**：组件里 `useEffect([open, buildRows])` 会
 * 在 buildRows 变化时重建匹配表，而 buildRows 依赖 animeList。如果 mock 每次
 * 渲染都返回新数组，effect 会无限触发（真实 context 里 animeList 由 reducer
 * 持有，引用天然稳定）。
 */
const hoisted = vi.hoisted(() => ({
  animeList: [
    {
      id: 'excel-1',
      title: '葬送的芙莉莲',
      posterUrl: '',
      category: 'watched',
      tags: [{ name: '奇幻', highlighted: false }],
      scores: [
        { dimensionKey: 'audio', score: 9 },
        { dimensionKey: 'plot', score: 9 },
      ],
      review: '好看',
      createdAt: '', updatedAt: '',
    },
  ],
}));

vi.mock('../../../context/AnimeContext', () => ({
  useAnimeContext: () => ({ state: { animeList: hoisted.animeList } }),
}));

import BangumiSyncModal from '../../../src/features/bangumi-sync/BangumiSyncModal';

describe('BangumiSyncModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ configured: false, loggedIn: false, loginPending: false }),
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** 渲染并等一轮微任务 + 一次 setTimeout，让账号状态的 fetch 落地 */
  async function renderModal() {
    await act(async () => {
      root.render(<BangumiSyncModal open onClose={() => {}} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // antd 的 Modal 渲染在 document.body 的 portal 里，不挂在本节点的 children 下
    return document.body.textContent ?? '';
  }

  it('打开时渲染三个页签', async () => {
    const text = await renderModal();
    expect(text).toContain('同步到 Bangumi');
    expect(text).toContain('账号');
    expect(text).toContain('匹配');
    expect(text).toContain('上传');
  });

  it('未配置凭据时提示先去注册应用', async () => {
    const text = await renderModal();
    expect(text).toContain('需要先在 Bangumi 注册一个应用');
    expect(text).toContain('App ID');
  });

  it('已登录时显示账号页签的勾', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        configured: true, loggedIn: true, loginPending: false,
        user: { id: 1, username: 'tester', nickname: '测试君' },
        clientId: 'abc', redirectUri: 'http://127.0.0.1:8765/callback',
      }),
    }));
    const text = await renderModal();
    expect(text).toContain('账号 ✓');
    expect(text).toContain('测试君');
  });
});
