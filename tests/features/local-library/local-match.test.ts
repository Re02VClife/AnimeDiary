import { describe, it, expect } from 'vitest';
import type { LocalFolder } from '../../../core/local-library';
import {
  mergeEpisodes,
  scoreFolderForAnime,
  suggestBindings,
} from '../../../src/features/local-library/local-match';

/** 造一个只填必要字段的目录 */
function makeFolder(over: Partial<LocalFolder> & { dirPath: string }): LocalFolder {
  return {
    dirName: over.dirName ?? '799_giriGiriLove',
    sourcePath: 'E:\\kazhumi Anime',
    episodes: [],
    guessedTitle: '',
    identify: { state: 'ok' },
    ...over,
  };
}

const efFolder = makeFolder({
  dirPath: 'E:\\kazhumi Anime\\799_giriGiriLove',
  dirName: '799_giriGiriLove',
  bangumiId: 799,
  meta: { name: 'ef - a tale of memories.', nameCn: '悠久之翼', totalEpisodes: 13 },
  episodes: [
    { number: 1, relPath: '1/video.mp4', fileName: 'video.mp4', size: 1 },
    { number: 2, relPath: '2/video.mp4', fileName: 'video.mp4', size: 1 },
  ],
});

const rakugoFolder = makeFolder({
  dirPath: 'E:\\kazhumi Anime\\800_other',
  dirName: '800_other',
  bangumiId: 800,
  meta: { name: '昭和元禄落語心中', nameCn: '昭和元禄落语心中' },
});

describe('scoreFolderForAnime — 三级判定', () => {
  it('bangumiId 一致 → 直接高置信，不看标题', () => {
    const match = scoreFolderForAnime({ title: '某种奇怪译名', bangumiId: 799 }, efFolder);
    expect(match.confidence).toBe('high');
    expect(match.reason).toBe('bangumiId');
    expect(match.score).toBe(1);
  });

  it('用户确认过的映射 → 高置信', () => {
    const match = scoreFolderForAnime({ title: '悠久之翼' }, efFolder, 799);
    expect(match.confidence).toBe('high');
    expect(match.reason).toBe('savedMatch');
  });

  it('中文名一致 → 标题命中', () => {
    const match = scoreFolderForAnime({ title: '悠久之翼' }, efFolder);
    expect(match.confidence).toBe('high');
    expect(match.reason).toBe('title');
  });

  it('完全不相干 → none', () => {
    const match = scoreFolderForAnime({ title: '进击的巨人' }, rakugoFolder);
    expect(match.confidence).toBe('none');
  });

  it('没有元数据时退回目录名', () => {
    const plain = makeFolder({
      dirPath: 'D:\\anime\\孤独摇滚',
      dirName: '孤独摇滚',
      guessedTitle: '孤独摇滚',
    });
    const match = scoreFolderForAnime({ title: '孤独摇滚' }, plain);
    expect(match.confidence).toBe('high');
  });
});

describe('suggestBindings', () => {
  it('同一部番的多个来源目录会全部绑上', () => {
    const mirror = makeFolder({
      dirPath: 'E:\\kazhumi Anime\\799_aafun',
      dirName: '799_aafun',
      bangumiId: 799,
      meta: { name: 'ef - a tale of memories.', nameCn: '悠久之翼' },
    });
    const suggestions = suggestBindings(
      [{ title: '悠久之翼', bangumiId: 799 }],
      [efFolder, mirror],
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].dirPaths.sort()).toEqual([
      'E:\\kazhumi Anime\\799_aafun',
      'E:\\kazhumi Anime\\799_giriGiriLove',
    ].sort());
    expect(suggestions[0].confidence).toBe('high');
  });

  it('没有 bangumiId 时只绑分数最高的那个目录', () => {
    const better = makeFolder({
      dirPath: 'D:\\a\\悠久之翼',
      dirName: '悠久之翼',
      guessedTitle: '悠久之翼',
    });
    const worse = makeFolder({
      dirPath: 'D:\\b\\久远之翼',
      dirName: '久远之翼',
      guessedTitle: '久远之翼',
    });
    const suggestions = suggestBindings([{ title: '悠久之翼' }], [better, worse]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].dirPaths).toEqual(['D:\\a\\悠久之翼']);
  });

  it('已有绑定的条目不再给建议', () => {
    const suggestions = suggestBindings(
      [{ title: '悠久之翼', bangumiId: 799 }],
      [efFolder],
      { existingKeys: new Set(['default::悠久之翼']) },
    );
    expect(suggestions).toHaveLength(0);
  });

  it('两个不同条目抢同一个目录 → 标记冲突，不参与一键绑定', () => {
    // 现实中是「中文名」和「日文名」被当成两条收录了，都指向 799 这个目录
    const suggestions = suggestBindings(
      [
        { title: '悠久之翼', bangumiId: 799 },
        { title: 'ef - a tale of memories.' },
      ],
      [efFolder],
    );
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((s) => s.conflict)).toBe(true);
  });

  it('savedSubjectLookup 生效', () => {
    const suggestions = suggestBindings(
      [{ title: '完全不同的名字' }],
      [efFolder],
      { savedSubjectLookup: (title) => (title === '完全不同的名字' ? 799 : undefined) },
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].reason).toBe('savedMatch');
  });
});

describe('mergeEpisodes', () => {
  it('多个目录合并并按集号排序，重复集号取前一个目录的', () => {
    const other = makeFolder({
      dirPath: 'E:\\kazhumi Anime\\799_aafun',
      bangumiId: 799,
      episodes: [
        { number: 2, relPath: '2/video.mp4', fileName: 'video.mp4', size: 999 },
        { number: 3, relPath: '3/video.mp4', fileName: 'video.mp4', size: 1 },
      ],
    });
    const merged = mergeEpisodes([efFolder.dirPath, other.dirPath], [efFolder, other]);
    expect(merged.map((e) => e.number)).toEqual([1, 2, 3]);
    // 第 2 集来自第一个目录（efFolder 的 size=1，不是 other 的 999）
    expect(merged[1].size).toBe(1);
    expect(merged[2].dirPath).toBe(other.dirPath);
  });

  it('目录已经从扫描结果里消失时直接跳过，不抛错', () => {
    expect(mergeEpisodes(['E:\\不存在'], [efFolder])).toEqual([]);
  });
});
