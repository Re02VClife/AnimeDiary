import { describe, it, expect } from 'vitest';
import {
  buildEpisodes,
  formatEpisodeNumber,
  guessTitleFromDirName,
  groupByBangumiId,
  isVideoFile,
  naturalCompare,
  parseEpisodeNumber,
  parseKazumiDirName,
  type LocalFolder,
} from '../../core/local-library';

describe('parseKazumiDirName（目录名 = Bangumi ID + 来源站）', () => {
  it('解析实测的 Kazumi 目录名', () => {
    expect(parseKazumiDirName('799_giriGiriLove')).toEqual({ bangumiId: 799, siteTag: 'giriGiriLove' });
    expect(parseKazumiDirName('50331_giriGiriLove')).toEqual({ bangumiId: 50331, siteTag: 'giriGiriLove' });
    expect(parseKazumiDirName('23119_aafun')).toEqual({ bangumiId: 23119, siteTag: 'aafun' });
    expect(parseKazumiDirName('624085_giriGiriLove')).toEqual({ bangumiId: 624085, siteTag: 'giriGiriLove' });
  });

  it('不是这个格式的普通目录名返回 null', () => {
    expect(parseKazumiDirName('葬送的芙莉莲')).toBeNull();
    expect(parseKazumiDirName('Season 1')).toBeNull();
    expect(parseKazumiDirName('_giriGiriLove')).toBeNull();
  });

  it('0 和超长数字不算合法 subject id', () => {
    expect(parseKazumiDirName('0_xxx')).toBeNull();
    expect(parseKazumiDirName('1234567890_xxx')).toBeNull();
  });
});

describe('parseEpisodeNumber（从目录名/文件名抠集号）', () => {
  it('纯数字就是集号（Kazumi 的子目录形态）', () => {
    expect(parseEpisodeNumber('1')).toBe(1);
    expect(parseEpisodeNumber('14')).toBe(14);
    expect(parseEpisodeNumber('108')).toBe(108);
  });

  it('分辨率/编码不能被误认成集号', () => {
    expect(parseEpisodeNumber('1080p')).toBeNull();
    expect(parseEpisodeNumber('[1080p]')).toBeNull();
    expect(parseEpisodeNumber('x264')).toBeNull();
    expect(parseEpisodeNumber('video')).toBeNull();
  });

  it('带标记的集号：- 03 / E12 / 第05话', () => {
    expect(parseEpisodeNumber('[Sub] Title - 03')).toBe(3);
    expect(parseEpisodeNumber('番名 E12')).toBe(12);
    expect(parseEpisodeNumber('EP03')).toBe(3);
    expect(parseEpisodeNumber('第05话')).toBe(5);
  });

  it('方括号里的组名/码率被去掉后再找', () => {
    expect(parseEpisodeNumber('[Lilith-Raws] 某番 - 07 [Baha][WEB-DL][1080p]')).toBe(7);
  });
});

describe('naturalCompare（选集条不能把第 10 集排到第 2 集前面）', () => {
  it('按数值而不是字典序', () => {
    const list = ['1', '10', '11', '2', '3', '9'];
    expect([...list].sort(naturalCompare)).toEqual(['1', '2', '3', '9', '10', '11']);
  });
});

describe('buildEpisodes（磁盘文件 → 集数列表）', () => {
  it('Kazumi 结构：<集号>/video.mp4', () => {
    const episodes = buildEpisodes([
      { relPath: '1/video.mp4', fileName: 'video.mp4', size: 100 },
      { relPath: '2/video.mp4', fileName: 'video.mp4', size: 100 },
      { relPath: '10/video.mp4', fileName: 'video.mp4', size: 100 },
    ]);
    expect(episodes.map((e) => e.number)).toEqual([1, 2, 10]);
    expect(episodes[2].relPath).toBe('10/video.mp4');
  });

  it('扁平结构：视频直接放在番剧目录里，集号看文件名', () => {
    const episodes = buildEpisodes([
      { relPath: '01.mp4', fileName: '01.mp4', size: 10 },
      { relPath: '02.mkv', fileName: '02.mkv', size: 20 },
    ]);
    expect(episodes.map((e) => e.number)).toEqual([1, 2]);
    expect(episodes[1].fileName).toBe('02.mkv');
  });

  it('非视频文件（字幕/封面）被忽略', () => {
    const episodes = buildEpisodes([
      { relPath: '1/video.mp4', fileName: 'video.mp4', size: 100 },
      { relPath: '1/sub.ass', fileName: 'sub.ass', size: 5 },
      { relPath: 'cover.jpg', fileName: 'cover.jpg', size: 9 },
    ]);
    expect(episodes).toHaveLength(1);
  });

  it('同一集号有多个文件时保留体积大的（正片 vs 样片）', () => {
    const episodes = buildEpisodes([
      { relPath: '1/preview.mp4', fileName: 'preview.mp4', size: 10 },
      { relPath: '1/main.mp4', fileName: 'main.mp4', size: 900 },
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].fileName).toBe('main.mp4');
  });
});

describe('guessTitleFromDirName', () => {
  it('Kazumi 目录不给兜底标题（不能拿来源站名当番名）', () => {
    expect(guessTitleFromDirName('799_giriGiriLove')).toBe('');
  });

  it('普通目录名直接用，去掉装饰括号', () => {
    expect(guessTitleFromDirName('葬送的芙莉莲')).toBe('葬送的芙莉莲');
    expect(guessTitleFromDirName('[Sub] 某番')).toBe('Sub 某番');
  });
});

describe('isVideoFile', () => {
  it('认识的容器', () => {
    for (const name of ['a.mp4', 'a.MKV', 'a.webm', 'a.avi', 'a.mov', 'a.ts', 'a.flv']) {
      expect(isVideoFile(name)).toBe(true);
    }
    expect(isVideoFile('a.ass')).toBe(false);
    expect(isVideoFile('a.jpg')).toBe(false);
  });

  it('HLS 分片不算视频（否则一部番会变成几百集）', () => {
    // Kazumi 把一集拆成 seg_00000.ts…seg_00327.ts + playlist.m3u8
    for (const name of ['seg_00000.ts', 'seg_00327.ts', 'seg_0.m4s', 'SEG_12.TS']) {
      expect(isVideoFile(name)).toBe(false);
    }
    // 但完整的 ts 视频仍然要认
    expect(isVideoFile('01.ts')).toBe(true);
    expect(isVideoFile('ep01.ts')).toBe(true);
    expect(isVideoFile('EP01.M2TS')).toBe(true);
  });
});

describe('formatEpisodeNumber', () => {
  it('整数原样显示', () => {
    expect(formatEpisodeNumber(12)).toBe('12');
  });
});

describe('groupByBangumiId', () => {
  it('同一部番的多个来源目录会归到一起', () => {
    const make = (dirPath: string, bangumiId: number): LocalFolder => ({
      dirPath,
      dirName: `${bangumiId}_x`,
      sourcePath: 'E:/x',
      bangumiId,
      episodes: [],
      guessedTitle: '',
      identify: { state: 'ok' },
    });
    const map = groupByBangumiId([make('A', 799), make('B', 799), make('C', 12)]);
    expect(map.get(799)).toHaveLength(2);
    expect(map.get(12)).toHaveLength(1);
  });
});
