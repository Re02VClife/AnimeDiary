import { describe, it, expect, beforeEach } from 'vitest';
import {
  shiftLocalRefsAfterRowDelete,
  loadCategoryMap,
  saveCategory,
  loadPosterPositions,
  savePosterPosition,
  loadWatchingDeleted,
  addToWatchingDeleted,
  loadPosterBlacklist,
  addToPosterBlacklist,
  loadDimReviews,
  saveDimReviews,
  loadEpisodeReviews,
  saveEpisodeReview,
} from '../../../features/anime-data/storage-service';
import type { DimensionReview, EpisodeReview } from '../../../src/types';

/**
 * 物理删除 Excel 行之后，所有以 `excel-<行号>` 为键的本地数据必须整体前移一位。
 * 不迁移的话不是"数据丢失"，而是**张冠李戴** —— 海报、焦点、分类会挂到别的条目上，
 * 这种错很难被发现，所以单独立测试守住。
 */
describe('shiftLocalRefsAfterRowDelete', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('删除第 5 行后：前面不动、被删的丢弃、后面的前移一位、非行号 id 不受影响', async () => {
    saveCategory('excel-3', 'watched');
    saveCategory('excel-5', 'watching'); // 这一行被删
    saveCategory('excel-7', 'watching');
    saveCategory('char-abc', 'watching'); // 手工建的条目，没有 Excel 行

    await shiftLocalRefsAfterRowDelete(5);

    const map = loadCategoryMap();
    expect(map['excel-3']).toBe('watched');
    expect(map['excel-5']).toBeUndefined();
    expect(map['excel-7']).toBeUndefined();
    expect(map['excel-6']).toBe('watching'); // 原 excel-7
    expect(map['char-abc']).toBe('watching');
  });

  it('海报焦点位置 / 拉黑名单 / 维度点评一起迁移', async () => {
    savePosterPosition('excel-8', 12, 34);
    addToWatchingDeleted('excel-9');
    addToPosterBlacklist('excel-10');
    saveDimReviews({
      'excel-11': [{ dimensionKey: 'story', text: '不错' } as unknown as DimensionReview],
    });

    await shiftLocalRefsAfterRowDelete(5);

    expect(loadPosterPositions()['excel-7']).toEqual({ x: 12, y: 34 });
    expect(loadWatchingDeleted().has('excel-8')).toBe(true);
    expect(loadPosterBlacklist().has('excel-9')).toBe(true);
    expect(loadDimReviews()['excel-10']).toBeDefined();
  });

  it('单集评价是数组，元素里的 animeId 也要迁移', async () => {
    saveEpisodeReview({ id: 'ep1', animeId: 'excel-20', episode: 1, text: '好看' } as unknown as EpisodeReview);
    saveEpisodeReview({ id: 'ep2', animeId: 'excel-2', episode: 1, text: '前移不变' } as unknown as EpisodeReview);
    saveEpisodeReview({ id: 'ep3', animeId: 'excel-5', episode: 1, text: '属于被删行的' } as unknown as EpisodeReview);
    saveEpisodeReview({ id: 'ep4', animeId: 'excel-6', episode: 1, text: '紧跟其后，要前移' } as unknown as EpisodeReview);

    await shiftLocalRefsAfterRowDelete(5);

    const all = loadEpisodeReviews();
    expect(all.find((r) => r.id === 'ep2')?.animeId).toBe('excel-2');
    expect(all.find((r) => r.id === 'ep1')?.animeId).toBe('excel-19');
    expect(all.find((r) => r.id === 'ep4')?.animeId).toBe('excel-5'); // 原 excel-6
    // 属于被删行的评价整条丢弃
    expect(all.find((r) => r.id === 'ep3')).toBeUndefined();
  });

  it('返回迁移的键数量，便于界面提示', async () => {
    saveCategory('excel-6', 'watched');
    saveCategory('excel-7', 'watched');
    const moved = await shiftLocalRefsAfterRowDelete(5);
    expect(moved).toBeGreaterThanOrEqual(2);
  });

  it('没有任何相关数据时不抛错', async () => {
    await expect(shiftLocalRefsAfterRowDelete(5)).resolves.toBe(0);
  });

  it('迁移后不会残留指向被删行的键', async () => {
    saveCategory('excel-1', 'watched');
    saveCategory('excel-2', 'watched');
    savePosterPosition('excel-2', 5, 5);
    addToWatchingDeleted('excel-2');

    await shiftLocalRefsAfterRowDelete(2);

    expect(loadCategoryMap()['excel-2']).toBeUndefined();
    expect(loadPosterPositions()['excel-2']).toBeUndefined();
    expect(loadWatchingDeleted().has('excel-2')).toBe(false);
    expect(loadCategoryMap()['excel-1']).toBe('watched');
  });
});
