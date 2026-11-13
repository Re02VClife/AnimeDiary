/**
 * MusicPicker 渲染冒烟测试
 *
 * 只验证「接线」：打开时能拉歌单、按 subtitle 给出本番推荐、能切到全部曲目。
 * 用 react-dom/client + act 手动渲染（项目没装 @testing-library/react，
 * 与 BangumiSyncModal.test.tsx 同样的取舍），断言直接看 document.body 文本 ——
 * antd Modal 会 portal 到 body 之外，容器里查不到。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import MusicPicker from '../../../features/music/MusicPicker';
import type { AnimeEntry } from '../../../src/types';

const playlist = {
  id: '8857836243',
  title: '动漫',
  desc: '我所看过的番',
  songCount: 2,
  fetchedAt: Date.now(),
  tracks: [
    {
      mid: '003AGGTc2Hdyro',
      name: '恋愛サーキュレーション',
      singer: '花澤香菜',
      album: '歌物語',
      subtitle: '《化物语》TV动画第10集片头曲',
      interval: 255,
      vip: true,
    },
    {
      mid: '001PAbnC1NHiR0',
      name: 'リズと青い鳥 第二楽章',
      singer: '北宇治高校吹奏楽部',
      album: 'girls,dance,staircase',
      subtitle: '《莉兹与青鸟》电影配乐',
      interval: 301,
    },
  ],
};

const anime: AnimeEntry = {
  id: 'excel-1',
  title: '化物语',
  posterUrl: '',
  category: 'watched',
  tags: [],
  scores: [{ dimensionKey: 'audio', score: 9 }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** 服务层只用到 ok / status / text()，没必要造一个真的 Response */
function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  } as unknown as Response;
}

let root: Root;
let container: HTMLDivElement;

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    if (check()) return;
  }
  throw new Error(`等待超时：${document.body.textContent?.slice(0, 300)}`);
}

function bodyHas(text: string): boolean {
  return (document.body.textContent || '').includes(text);
}

function clickByText(text: string): void {
  const target = Array.from(document.body.querySelectorAll<HTMLElement>('div,span'))
    .filter((el) => el.children.length === 0 && (el.textContent || '').includes(text))
    .pop();
  if (!target) throw new Error(`找不到可点的文本：${text}`);
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('MusicPicker', () => {
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

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/music/store')) {
        return jsonResponse({
          store: {
            version: 1,
            updatedAt: new Date().toISOString(),
            settings: { playlistUrl: '8857836243' },
            bindings: {},
          },
        });
      }
      if (url.includes('/api/music/playlist')) {
        return jsonResponse({ playlist, settings: { playlistUrl: '8857836243' } });
      }
      return jsonResponse({});
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('打开后拉到歌单，并只把《化物语》那一首排进推荐', async () => {
    await act(async () => {
      root.render(<MusicPicker open anime={anime} onClose={() => {}} />);
    });

    await waitFor(() => bodyHas('恋愛サーキュレーション'));
    expect(bodyHas('歌单：动漫 · 2 首')).toBe(true);
    // 另一首不该出现在推荐页
    expect(bodyHas('リズと青い鳥')).toBe(false);
  });

  it('切到全部曲目能看到歌单里的每一首', async () => {
    await act(async () => {
      root.render(<MusicPicker open anime={anime} onClose={() => {}} />);
    });
    await waitFor(() => bodyHas('恋愛サーキュレーション'));

    clickByText('全部曲目');
    await waitFor(() => bodyHas('リズと青い鳥'));
  });
});
