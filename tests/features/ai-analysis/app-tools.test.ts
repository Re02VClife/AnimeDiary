/**
 * features/ai-analysis/app-tools 单测
 *
 * 重点不是「工具能跑」，而是三条边界：
 *   1. read 档根本不注册写工具；
 *   2. confirm 档的写工具必须经过 approve，拒绝后一个字都不写；
 *   3. 写操作只调用 host.saveAnime（唯一 Excel 写入口），不自己碰数据。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { AnimeEntry } from '../../../src/types';
import { createAppTools, listAppToolSpecs, type AppToolHost } from '../../../features/ai-analysis/app-tools';
import type { AppToolRuntime } from '../../../core/app-tools';

function makeEntry(over: Partial<AnimeEntry> = {}): AnimeEntry {
  return {
    id: 'excel-1',
    excelRowIndex: 1,
    title: '86 不存在的战区 part1',
    posterUrl: '',
    category: 'watched',
    tags: [
      { name: '战争', highlighted: false },
      { name: '轻小说改', highlighted: false },
    ],
    scores: [
      { dimensionKey: 'plot', score: 9 },
      { dimensionKey: 'overall', score: 8.9 },
    ],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...over,
  };
}

function makeHost(list: AnimeEntry[]) {
  const saved: AnimeEntry[] = [];
  const host: AppToolHost = {
    get list() { return list; },
    async saveAnime(updated) {
      saved.push(updated);
    },
  };
  return { host, saved };
}

function find(tools: AppToolRuntime[], name: string): AppToolRuntime {
  const hit = tools.find((t) => t.spec.name === name);
  if (!hit) throw new Error(`没找到工具 ${name}`);
  return hit;
}

describe('注册期的权限裁剪', () => {
  it('read 档只暴露只读工具，写工具连定义都不给', () => {
    const { host } = makeHost([makeEntry()]);
    const tools = createAppTools(host, 'read');
    expect(tools.every((t) => t.spec.effect === 'read')).toBe(true);
    expect(tools.map((t) => t.spec.name).sort()).toEqual([
      'app_anime_get', 'app_anime_list', 'app_music_match', 'app_music_search', 'app_tag_stats',
    ]);
  });

  it('confirm / write 档暴露全部工具', () => {
    const { host } = makeHost([makeEntry()]);
    expect(createAppTools(host, 'confirm')).toHaveLength(listAppToolSpecs().length);
    expect(createAppTools(host, 'write')).toHaveLength(listAppToolSpecs().length);
  });
});

describe('只读工具', () => {
  it('app_anime_list 按分类 / 标签 / 关键词筛选并限制条数', async () => {
    const list = [
      makeEntry(),
      makeEntry({ id: 'excel-2', title: '冰菓', category: 'watching', tags: [{ name: '校园', highlighted: false }] }),
    ];
    const { host } = makeHost(list);
    const tools = createAppTools(host, 'write');

    const all = await find(tools, 'app_anime_list').run({}) as { total: number; items: unknown[] };
    expect(all.total).toBe(2);

    const watched = await find(tools, 'app_anime_list').run({ category: 'watched' }) as { total: number };
    expect(watched.total).toBe(1);

    const tagged = await find(tools, 'app_anime_list').run({ tag: '校园' }) as { total: number };
    expect(tagged.total).toBe(1);

    const limited = await find(tools, 'app_anime_list').run({ limit: 1 }) as { returned: number };
    expect(limited.returned).toBe(1);
  });

  it('app_anime_get 返回详情；找不到 / 歧义时给出明确错误码', async () => {
    const { host } = makeHost([
      makeEntry(),
      makeEntry({ id: 'excel-2', title: '86 不存在的战区 part2' }),
    ]);
    const tools = createAppTools(host, 'write');

    const detail = await find(tools, 'app_anime_get').run({ title: '86 不存在的战区 part2' }) as { title: string };
    expect(detail.title).toBe('86 不存在的战区 part2');

    await expect(find(tools, 'app_anime_get').run({ title: '没有这部' }))
      .rejects.toThrow(/\[NOT_FOUND\]/);
    await expect(find(tools, 'app_anime_get').run({ title: '86 不存在的战区' }))
      .rejects.toThrow(/\[AMBIGUOUS\]/);
  });

  it('app_tag_stats 按使用次数降序', async () => {
    const { host } = makeHost([
      makeEntry(),
      makeEntry({ id: 'excel-2', title: '冰菓', tags: [{ name: '战争', highlighted: false }] }),
    ]);
    const tools = createAppTools(host, 'read');
    const out = await find(tools, 'app_tag_stats').run({}) as { tags: Array<{ name: string; count: number }> };
    expect(out.tags[0]).toEqual({ name: '战争', count: 2 });
    expect(out.tags.find((t) => t.name === '轻小说改')?.count).toBe(1);
  });
});

describe('写工具', () => {
  it('app_anime_update 只改传入字段并调用 saveAnime', async () => {
    const entry = makeEntry();
    const { host, saved } = makeHost([entry]);
    const tools = createAppTools(host, 'write');

    const out = await find(tools, 'app_anime_update').run({
      title: entry.title,
      category: 'watching',
      scores: { plot: 8.5, unknown: 9.9 },
    }) as { changed: string[] };

    expect(out.changed).toContain('category');
    expect(out.changed).toContain('scores');
    expect(saved).toHaveLength(1);
    expect(saved[0].category).toBe('watching');
    expect(saved[0].tags).toEqual(entry.tags); // 未传的字段原样保留
    expect(saved[0].scores.find((s) => s.dimensionKey === 'plot')?.score).toBe(8.5);
    expect(saved[0].scores.some((s) => s.dimensionKey === 'unknown')).toBe(false);
  });

  it('app_tag_add 跳过已存在标签', async () => {
    const entry = makeEntry();
    const { host, saved } = makeHost([entry]);
    const tools = createAppTools(host, 'write');

    const out = await find(tools, 'app_tag_add').run({
      title: entry.title,
      tags: ['战争', '公路片'],
    }) as { added: string[] };

    expect(out.added).toEqual(['公路片']);
    expect(saved[0].tags.map((t) => t.name)).toContain('公路片');
  });

  it('app_tag_remove 按归一化匹配删除', async () => {
    const entry = makeEntry({ tags: [{ name: '科幻 ', highlighted: false }, { name: '战争', highlighted: false }] });
    const { host, saved } = makeHost([entry]);
    const tools = createAppTools(host, 'write');

    const out = await find(tools, 'app_tag_remove').run({
      title: entry.title,
      tags: ['科幻'],
    }) as { removed: string[] };

    expect(out.removed).toEqual(['科幻 ']);
    expect(saved[0].tags.map((t) => t.name)).toEqual(['战争']);
  });

  it('confirm 档：用户拒绝时抛 FORBIDDEN 且不写', async () => {
    const entry = makeEntry();
    const { host, saved } = makeHost([entry]);
    host.approve = async () => false;
    const tools = createAppTools(host, 'confirm');

    await expect(find(tools, 'app_tag_add').run({ title: entry.title, tags: ['公路片'] }))
      .rejects.toThrow(/\[FORBIDDEN\]/);
    expect(saved).toHaveLength(0);
  });

  it('confirm 档：用户允许后正常写入', async () => {
    const entry = makeEntry();
    const { host, saved } = makeHost([entry]);
    host.approve = async () => true;
    const tools = createAppTools(host, 'confirm');

    await find(tools, 'app_tag_add').run({ title: entry.title, tags: ['公路片'] });
    expect(saved).toHaveLength(1);
  });

  it('write 档不弹确认，直接写入', async () => {
    const entry = makeEntry();
    const { host, saved } = makeHost([entry]);
    host.approve = async () => { throw new Error('不该调用 approve'); };
    const tools = createAppTools(host, 'write');

    await find(tools, 'app_tag_add').run({ title: entry.title, tags: ['公路片'] });
    expect(saved).toHaveLength(1);
  });
});

// ── 音乐工具 ──
//
// 歌单来自 /api/music/playlist（服务端已缓存 6 小时），这里用假 fetch 顶掉，
// 只验证「歌单 → 番」的匹配口径与绑定入口，不碰真实网络。

const PLAYLIST_FIXTURE = {
  id: '8857836243',
  title: '动漫',
  songCount: 3,
  fetchedAt: 0,
  tracks: [
    { mid: '003AGGTc2Hdyro', name: '恋愛サーキュレーション', singer: '花澤香菜', album: '歌物語', subtitle: '《化物语》TV动画第10集片头曲', interval: 255, vip: true },
    { mid: '003mV4wq0syICL', name: 'staple stable', singer: '斎藤千和', album: '化物語', subtitle: '《化物语》TV动画片头曲', interval: 276 },
    { mid: '001PAbnC1NHiR0', name: 'リズと青い鳥 第二楽章', singer: '北宇治高校吹奏楽部', album: 'girls,dance,staircase', subtitle: '《莉兹与青鸟》电影配乐', interval: 301 },
  ],
};

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/music/playlist')) return jsonResponse({ playlist: PLAYLIST_FIXTURE });
    if (url.includes('/api/music/search')) {
      return jsonResponse({ tracks: [{ mid: '00451VFK3AGNME', name: '恋爱循环', singer: 'Miko孙涵', album: '' }] });
    }
    return jsonResponse({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('音乐工具', () => {
  it('app_music_match 不传番名时扫全歌单，按 subtitle 反查归属，并跳过角色卡', async () => {
    const { host } = makeHost([
      makeEntry({ id: 'e1', title: '化物语' }),
      makeEntry({ id: 'e2', title: '莉兹与青鸟' }),
      // 角色卡：名字是番名的子串，混进匹配池会抢归属
      makeEntry({ id: 'c1', title: '芙莉莲', templateId: 'character' }),
    ]);
    const tools = createAppTools(host, 'read');
    const out = await find(tools, 'app_music_match').run({}) as {
      playlist: { title: string; count: number };
      library: number;
      characterCardsSkipped: number;
      matched: number;
      items: Array<{ mid: string; anime: string | null; matchedBy: string | null }>;
    };

    expect(out.playlist.title).toBe('动漫');
    expect(out.playlist.count).toBe(3);
    expect(out.matched).toBe(3);
    // 匹配池只算番剧：3 部里扣掉 1 张角色卡
    expect(out.library).toBe(2);
    expect(out.characterCardsSkipped).toBe(1);
    // 按匹配分降序：番名越长命中越不可能是巧合，分越高
    expect(out.items.map((i) => i.anime)).toEqual(['莉兹与青鸟', '化物语', '化物语']);
    expect(out.items.every((i) => i.matchedBy === 'subtitle')).toBe(true);
  });

  it('app_music_match 把角色卡标题当番名时给出明确提示', async () => {
    const { host } = makeHost([
      makeEntry({ id: 'e1', title: '化物语' }),
      makeEntry({ id: 'c1', title: '芙莉莲', templateId: 'character' }),
    ]);
    const tools = createAppTools(host, 'read');

    await expect(find(tools, 'app_music_match').run({ animeTitle: '芙莉莲' }))
      .rejects.toThrow(/角色卡/);
  });

  it('app_music_match 传番名时只返回这一部的歌', async () => {
    const { host } = makeHost([makeEntry({ id: 'e1', title: '化物语' })]);
    const tools = createAppTools(host, 'read');
    const out = await find(tools, 'app_music_match').run({ animeTitle: '化物语' }) as {
      anime: string;
      items: Array<{ mid: string }>;
    };
    expect(out.anime).toBe('化物语');
    expect(out.items.map((i) => i.mid)).toEqual(['003AGGTc2Hdyro', '003mV4wq0syICL']);
  });

  it('app_music_search 返回 QQ 音乐的搜索结果', async () => {
    const { host } = makeHost([makeEntry()]);
    const tools = createAppTools(host, 'read');
    const out = await find(tools, 'app_music_search').run({ query: '恋爱循环' }) as {
      items: Array<{ mid: string; name: string }>;
    };
    expect(out.items[0]).toMatchObject({ mid: '00451VFK3AGNME', name: '恋爱循环' });
  });

  it('app_music_bind 走 host.bindMusic，不碰 Excel', async () => {
    const entry = makeEntry({ title: '化物语' });
    const { host, saved } = makeHost([entry]);
    const bound: Array<{ anime: string; mid: string }> = [];
    host.bindMusic = async (target, track) => { bound.push({ anime: target.title, mid: track.mid }); };
    const tools = createAppTools(host, 'write');

    const out = await find(tools, 'app_music_bind').run({
      animeTitle: '化物语',
      mid: '003mV4wq0syICL',
    }) as { ok: boolean; track: { name: string } };

    expect(out.ok).toBe(true);
    expect(out.track.name).toBe('staple stable');
    expect(bound).toEqual([{ anime: '化物语', mid: '003mV4wq0syICL' }]);
    expect(saved).toHaveLength(0); // 音乐绑定不写 Excel
  });

  it('app_music_bind 在 confirm 档被拒后不绑定', async () => {
    const { host } = makeHost([makeEntry({ title: '化物语' })]);
    let binds = 0;
    host.bindMusic = async () => { binds += 1; };
    host.approve = async () => false;
    const tools = createAppTools(host, 'confirm');

    await expect(find(tools, 'app_music_bind').run({ animeTitle: '化物语', mid: '003mV4wq0syICL' }))
      .rejects.toThrow(/\[FORBIDDEN\]/);
    expect(binds).toBe(0);
  });

  it('app_music_bind 找不到歌名时给 NOT_FOUND', async () => {
    const { host } = makeHost([makeEntry({ title: '化物语' })]);
    host.bindMusic = async () => {};
    const tools = createAppTools(host, 'write');

    await expect(find(tools, 'app_music_bind').run({ animeTitle: '化物语', songName: '不存在' }))
      .rejects.toThrow(/\[NOT_FOUND\]/);
  });
});
