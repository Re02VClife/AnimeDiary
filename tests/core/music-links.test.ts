/**
 * core/music-links 单元测试
 *
 * 重点覆盖三处「一改就容易悄悄坏」的地方：
 *   1. QQ 音乐 SSR 里带裸 `undefined` 的伪 JSON（标准 JSON.parse 会直接抛）；
 *   2. 花括号配平（歌单对象里嵌着带 `};` 的字符串，正则一定截断在怪地方）；
 *   3. 番名 ↔ subtitle 的匹配优先级（这是「本番推荐」唯一的准确来源）。
 */
import { describe, expect, it } from 'vitest';
import {
  animeKeyFor,
  dedupeTracks,
  extractInitialData,
  formatTrackDuration,
  parsePlaylistPage,
  parseSongDetailPage,
  playlistIdFromSource,
  rankTracksForAnime,
  replaceBareUndefined,
  scoreTrackForAnime,
  songMidFromUrl,
  titleVariants,
} from '../../core/music-links';
import type { MusicTrack } from '../../core/music-links';

function page(data: string): string {
  return `<!DOCTYPE html><html><body><script>window.__USE_SSR__=true; window.__INITIAL_DATA__ =${data};</script></body></html>`;
}

const PLAYLIST_DATA = `{
  "detail": {
    "id": 8857836243,
    "dirid": 5,
    "title": "动漫",
    "desc": "我所看过的番（含 } 和 { 的说明）",
    "picurl": "\\u002F\\u002Fy.qq.com\\u002Fmusic\\u002Fphoto_new\\u002Fa.jpg",
    "songnum": 177,
    "songList": [
      {
        "mid": "003AGGTc2Hdyro",
        "name": "恋愛サーキュレーション",
        "title_hilight": undefined,
        "subtitle": "《化物语》TV动画第10集片头曲|《历物语》TV动画第5集片头曲",
        "interval": 255,
        "isVip": true,
        "singer": [{ "name": "花澤香菜" }],
        "album": { "name": "歌物語 Special Edition" },
        "coverUrl": "\\u002F\\u002Fy.qq.com\\u002Fmusic\\u002Fphoto_new\\u002FM000004eSusD1skn9s_3.jpg"
      },
      {
        "mid": "003mV4wq0syICL",
        "name": "staple stable",
        "subtitle": "《化物语》TV动画片头曲",
        "interval": 276,
        "pay": { "payplay": 0 },
        "singer": [{ "name": "斎藤千和" }, { "name": "神谷浩史" }],
        "album": { "name": "化物語" }
      },
      { "mid": "", "name": "已下架占位" }
    ]
  }
}`;

describe('replaceBareUndefined', () => {
  it('把裸 undefined 换成 null，字符串里的不动', () => {
    const input = '{"a":undefined,"b":"undefined","c":[1,undefined]}';
    expect(JSON.parse(replaceBareUndefined(input))).toEqual({ a: null, b: 'undefined', c: [1, null] });
  });

  it('保留普通对象原样', () => {
    const input = '{"a":1,"b":{"c":"x"}}';
    expect(replaceBareUndefined(input)).toBe(input);
  });
});

describe('extractInitialData', () => {
  it('能穿过字符串里的花括号与转义引号', () => {
    const html = page('{"detail":{"title":"a}b{c\\"d","list":[{"x":1}]}}');
    const data = extractInitialData(html);
    expect(data?.detail?.title).toBe('a}b{c"d');
    expect(data?.detail?.list).toHaveLength(1);
  });

  it('带 undefined 的伪 JSON 也能解析', () => {
    const html = page('{"detail":{"a":undefined,"b":2}}');
    expect(extractInitialData(html)).toEqual({ detail: { a: null, b: 2 } });
  });

  it('没有数据时返回 null，不抛异常', () => {
    expect(extractInitialData('<html></html>')).toBeNull();
    expect(extractInitialData('')).toBeNull();
  });
});

describe('parsePlaylistPage', () => {
  const playlist = parsePlaylistPage(page(PLAYLIST_DATA));

  it('解析出歌单基本信息', () => {
    expect(playlist?.id).toBe('8857836243');
    expect(playlist?.title).toBe('动漫');
    expect(playlist?.songCount).toBe(177);
    expect(playlist?.desc).toContain('我所看过的番');
    // // 开头的协议相对地址补成 https
    expect(playlist?.coverUrl).toBe('https://y.qq.com/music/photo_new/a.jpg');
  });

  it('丢弃 mid 非法的占位条目', () => {
    expect(playlist?.tracks.map((t) => t.mid)).toEqual(['003AGGTc2Hdyro', '003mV4wq0syICL']);
  });

  it('歌手 / 出处 / 会员标记 / 封面都带出来', () => {
    const [vip, free] = playlist!.tracks;
    expect(vip.name).toBe('恋愛サーキュレーション');
    expect(vip.singer).toBe('花澤香菜');
    expect(vip.album).toBe('歌物語 Special Edition');
    expect(vip.subtitle).toContain('化物语');
    expect(vip.interval).toBe(255);
    expect(vip.vip).toBe(true);
    expect(vip.coverUrl).toBe('https://y.qq.com/music/photo_new/M000004eSusD1skn9s_3.jpg');

    expect(free.vip).toBeUndefined();
    expect(free.singer).toBe('斎藤千和 / 神谷浩史');
  });

  it('页面里没有 detail 时返回 null', () => {
    expect(parsePlaylistPage(page('{"other":1}'))).toBeNull();
  });

  it('曲目在顶层 songList 时也能读（2026-11 的真实页面结构）', () => {
    const html = page(JSON.stringify({
      detail: { id: 123456, title: '动漫', songnum: 1, desc: '测试' },
      songList: [{
        mid: '001PAbnC1NHiR0',
        name: 'リズと青い鳥 第二楽章',
        singer: [{ name: '北宇治高校吹奏楽部' }],
        album: { name: 'girls,dance,staircase', mid: '003NE4Ov0iPWSM' },
        subtitle: '《莉兹与青鸟》电影配乐',
        interval: 301,
      }],
      totalNum: 1,
    }));
    const parsed = parsePlaylistPage(html);
    expect(parsed?.tracks).toHaveLength(1);
    expect(parsed?.tracks[0].name).toBe('リズと青い鳥 第二楽章');
    // 歌单接口只给 album.mid，封面要按图床规律拼出来
    expect(parsed?.tracks[0].coverUrl).toBe('https://y.qq.com/music/photo_new/T002R300x300M000003NE4Ov0iPWSM.jpg');
    expect(parsed?.songCount).toBe(1);
  });
});

describe('parseSongDetailPage', () => {
  it('用 URL 里的 mid 补齐（详情页只有数字 id）', () => {
    const html = page(JSON.stringify({
      detail: {
        title: 'staple stable',
        singer: [{ name: '斎藤千和' }],
        albumName: '化物語',
        picurl: '//y.qq.com/music/photo_new/x.jpg',
        interval: 276,
      },
    }));
    const track = parseSongDetailPage(html, '003mV4wq0syICL');
    expect(track).toMatchObject({
      mid: '003mV4wq0syICL',
      name: 'staple stable',
      singer: '斎藤千和',
      album: '化物語',
      interval: 276,
    });
  });

  it('mid 非法时返回 null', () => {
    const html = page('{"detail":{"title":"x"}}');
    expect(parseSongDetailPage(html, '!!')).toBeNull();
  });
});

describe('songMidFromUrl', () => {
  it('认各种形态的歌曲链接', () => {
    expect(songMidFromUrl('003AGGTc2Hdyro')).toBe('003AGGTc2Hdyro');
    expect(songMidFromUrl('https://y.qq.com/n/ryqq/songDetail/003AGGTc2Hdyro')).toBe('003AGGTc2Hdyro');
    expect(songMidFromUrl('https://y.qq.com/n/ryqq_v2/songDetail/003AGGTc2Hdyro')).toBe('003AGGTc2Hdyro');
    expect(songMidFromUrl('https://y.qq.com/n/yqq/song/003mV4wq0syICL.html')).toBe('003mV4wq0syICL');
    expect(songMidFromUrl('https://y.qq.com/portal/player.html?songmid=003mV4wq0syICL')).toBe('003mV4wq0syICL');
  });

  it('认不出来时返回 null', () => {
    expect(songMidFromUrl('')).toBeNull();
    expect(songMidFromUrl('https://y.qq.com/n/ryqq/playlist/123456')).toBeNull();
  });
});

describe('playlistIdFromSource', () => {
  it('认纯数字 / 歌单页 / 带 id 的查询串', () => {
    expect(playlistIdFromSource('8857836243')).toBe('8857836243');
    expect(playlistIdFromSource('https://y.qq.com/n/ryqq_v2/playlist/8857836243')).toBe('8857836243');
    expect(playlistIdFromSource('https://y.qq.com/n/yqq/playlist.html?id=8857836243')).toBe('8857836243');
  });

  it('短链认不出来（要靠跳转后解析），返回 null', () => {
    expect(playlistIdFromSource('https://c6.y.qq.com/base/fcgi-bin/u?__=AmDkRqhzq7FQ')).toBeNull();
  });
});

describe('animeKeyFor', () => {
  it('模板 + 标题相同 → key 相同；标题大小写/空格归一', () => {
    expect(animeKeyFor({ title: 'Frieren', templateId: 'default' }))
      .toBe(animeKeyFor({ title: '  frieren ', templateId: 'default' }));
  });

  it('不同模板互不串台', () => {
    expect(animeKeyFor({ title: '芙莉莲', templateId: 'character' }))
      .not.toBe(animeKeyFor({ title: '芙莉莲', templateId: 'default' }));
    // 没给模板按 default 算
    expect(animeKeyFor({ title: '芙莉莲' })).toBe(animeKeyFor({ title: '芙莉莲', templateId: 'default' }));
  });
});

describe('titleVariants', () => {
  it('中文名 / 日文名 / 别名都算，单字丢掉', () => {
    expect(titleVariants({ title: '化物语', titleJa: '化物語', searchAlias: '物语 / 刀' }))
      .toEqual(['化物语', '化物語', '物语']);
  });
});

describe('rankTracksForAnime', () => {
  const tracks: MusicTrack[] = [
    { mid: 'aaa1111111', name: '恋爱循环', singer: '花澤香菜', album: '歌物語', subtitle: '《化物语》TV动画第10集片头曲' },
    { mid: 'bbb2222222', name: 'staple stable', singer: '斎藤千和', album: '化物語', subtitle: '《化物语》TV动画片头曲' },
    { mid: 'ccc3333333', name: '无关曲目', singer: '某人', album: '别的专辑' },
    { mid: 'ddd4444444', name: 'My Soul, Your Beats!', singer: 'Lia', album: 'Angel Beats!', subtitle: '《Angel Beats!》TV动画片头曲' },
  ];

  it('按 subtitle 命中排序，没命中的丢掉', () => {
    const ranked = rankTracksForAnime(tracks, { title: '化物语' });
    expect(ranked.map((t) => t.mid)).toEqual(['aaa1111111', 'bbb2222222']);
  });

  it('用别名也能命中', () => {
    const ranked = rankTracksForAnime(tracks, { title: '物語', searchAlias: '化物语' });
    expect(ranked).toHaveLength(2);
  });

  it('titleJa 命中同样算', () => {
    const ranked = rankTracksForAnime(tracks, { title: 'Bakemonogatari', titleJa: '化物語' });
    expect(ranked.map((t) => t.mid)).toContain('bbb2222222');
  });

  it('没有可用番名时返回空（不瞎猜）', () => {
    expect(rankTracksForAnime(tracks, { title: '刀' })).toEqual([]);
    expect(rankTracksForAnime(tracks, null)).toEqual([]);
  });

  it('subtitle 命中比专辑命中分高', () => {
    const subtitleHit = { mid: 'a1', name: 'x', singer: '', album: '', subtitle: '《化物语》片头曲' };
    const albumHit = { mid: 'a2', name: 'x', singer: '', album: '化物语', subtitle: '' };
    const variants = titleVariants({ title: '化物语' });
    expect(scoreTrackForAnime(subtitleHit, variants)).toBeGreaterThan(scoreTrackForAnime(albumHit, variants));
  });
});

describe('小工具', () => {
  it('时长格式化', () => {
    expect(formatTrackDuration(255)).toBe('4:15');
    expect(formatTrackDuration(59)).toBe('0:59');
    expect(formatTrackDuration(0)).toBe('--:--');
    expect(formatTrackDuration(undefined)).toBe('--:--');
  });

  it('按 mid 去重且保序', () => {
    const list: MusicTrack[] = [
      { mid: 'a', name: '1', singer: '', album: '' },
      { mid: 'b', name: '2', singer: '', album: '' },
      { mid: 'a', name: '1 重复', singer: '', album: '' },
    ];
    expect(dedupeTracks(list).map((t) => t.name)).toEqual(['1', '2']);
  });
});
