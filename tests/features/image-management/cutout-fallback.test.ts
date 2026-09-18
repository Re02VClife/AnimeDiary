import { describe, it, expect } from 'vitest';
import { applyCutout, fallbackPosterUrl } from '../../../features/image-management/cutout-service';

const imgUrl = (anime: string, file: string) =>
  `/api/images/file?anime=${encodeURIComponent(anime)}&file=${encodeURIComponent(file)}`;

/**
 * 这组测试守住一个真实事故：AI 抠图的**暂存**文件 URL 被当成海报存了下来，
 * 而暂存文件在用户点「应用」时会被改名成 cover-nobg.png —— URL 随即永久 404，
 * 卡片就只剩占位图（实测 37 张角色卡中招）。
 *
 * 两道防线：
 *   1. fallbackPosterUrl —— 加载失败时退回同目录原图，先把画面救回来
 *   2. applyCutout 不会把暂存文件误判成去底版
 */
describe('fallbackPosterUrl', () => {
  it('去底图缺失时回退到同目录的原图', () => {
    expect(fallbackPosterUrl(imgUrl('赫斯缇雅', 'cover-nobg.png')))
      .toBe(imgUrl('赫斯缇雅', 'cover.jpg'));
  });

  it('AI 暂存文件失效时也能回退', () => {
    expect(fallbackPosterUrl(imgUrl('山田杏奈', 'cover-nobg.preview.png')))
      .toBe(imgUrl('山田杏奈', 'cover.jpg'));
  });

  it('本来指向原图时返回 null —— 否则会无限重试同一张图', () => {
    expect(fallbackPosterUrl(imgUrl('X', 'cover.jpg'))).toBeNull();
    expect(fallbackPosterUrl(imgUrl('X', 'cover.png'))).toBeNull();
    expect(fallbackPosterUrl(imgUrl('X', 'cover.webp'))).toBeNull();
  });

  it('用户截图（{名}_1.png）失效时也回退到原图', () => {
    expect(fallbackPosterUrl(imgUrl('X', 'X_1.png'))).toBe(imgUrl('X', 'cover.jpg'));
  });

  it('外链不回退（不归本地目录管）', () => {
    expect(fallbackPosterUrl('https://lain.bgm.tv/pic/cover/l/ab/cd/123.jpg')).toBeNull();
    expect(fallbackPosterUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(fallbackPosterUrl('')).toBeNull();
  });

  it('保留原始的 anime 参数编码，不做二次编码', () => {
    const encoded = encodeURIComponent('阿库亚 _ 星野爱久爱海');
    expect(fallbackPosterUrl(`/api/images/file?anime=${encoded}&file=cover-nobg.png`))
      .toBe(`/api/images/file?anime=${encoded}&file=cover.jpg`);
  });
});

describe('applyCutout 与暂存文件', () => {
  it('暂存文件不会被当成去底版替换', () => {
    const url = imgUrl('山田杏奈', 'cover-nobg.preview.png');
    expect(applyCutout(url, new Set(['山田杏奈']))).toBe(url);
  });

  it('原图才会被替换成去底版', () => {
    expect(applyCutout(imgUrl('山田杏奈', 'cover.jpg'), new Set(['山田杏奈'])))
      .toBe(imgUrl('山田杏奈', 'cover-nobg.png'));
  });

  it('用户截图不会被替换', () => {
    const url = imgUrl('山田杏奈', '山田杏奈_1.png');
    expect(applyCutout(url, new Set(['山田杏奈']))).toBe(url);
  });

  it('目录不在索引里时原样返回', () => {
    const url = imgUrl('某人', 'cover.jpg');
    expect(applyCutout(url, new Set(['别人']))).toBe(url);
  });
});
