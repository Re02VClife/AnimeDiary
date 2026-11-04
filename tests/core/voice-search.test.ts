/**
 * core/voice-search 单元测试
 *
 * 排序错了的代价是「点了生成，抓回来一段翻唱或声线教学」，
 * 所以这里锁住两类行为：台词合集要排前面，教学/翻唱/鬼畜要排后面。
 */
import { describe, it, expect } from 'vitest';
import { parseBiliDuration, rankVoiceCandidates } from '../../core/voice-search';
import type { VoiceCandidate } from '../../core/voice-search';

function candidate(partial: Partial<VoiceCandidate> & { title: string }): VoiceCandidate {
  return {
    bvid: 'BV1xx411c7mD',
    durationSeconds: 180,
    play: 5000,
    author: 'up',
    coverUrl: null,
    pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    score: 0,
    ...partial,
  };
}

describe('parseBiliDuration', () => {
  it('解析 m:ss 与 h:mm:ss', () => {
    expect(parseBiliDuration('4:25')).toBe(265);
    expect(parseBiliDuration('1:02:03')).toBe(3723);
    expect(parseBiliDuration('690:23')).toBe(41423);
  });

  it('已是秒数的直接返回', () => {
    expect(parseBiliDuration(265)).toBe(265);
    expect(parseBiliDuration('265')).toBe(265);
  });

  it('非法值返回 0', () => {
    expect(parseBiliDuration('')).toBe(0);
    expect(parseBiliDuration('abc')).toBe(0);
    expect(parseBiliDuration(undefined)).toBe(0);
    expect(parseBiliDuration('1:x')).toBe(0);
  });
});

describe('rankVoiceCandidates', () => {
  it('角色名 + 台词合集的排最前', () => {
    const ranked = rankVoiceCandidates(
      [
        candidate({ title: '【原神】B站首发！雷神全好感语音！', durationSeconds: 1688, play: 1279981 }),
        candidate({ title: '雷电将军那些震撼心灵的台词', durationSeconds: 249, play: 3301 }),
        candidate({ title: '怎么学雷电将军的声线', durationSeconds: 125, play: 1665 }),
        candidate({ title: '今天吃什么', durationSeconds: 180, play: 90000 }),
      ],
      '雷电将军',
    );
    // 与角色无关的必须垫底
    expect(ranked[ranked.length - 1].title).toBe('今天吃什么');
    // 声线教学要排在有角色名的台词合集后面
    const teaching = ranked.findIndex((r) => r.title.includes('声线'));
    const lines = ranked.findIndex((r) => r.title.includes('台词'));
    expect(lines).toBeLessThan(teaching);
  });

  it('标题含角色名但内容是翻唱/MAD 的降权', () => {
    const normal = candidate({ title: '薇尔莉特 台词合集', durationSeconds: 200 });
    const cover = candidate({ title: '薇尔莉特 翻唱', durationSeconds: 200 });
    const ranked = rankVoiceCandidates([cover, normal], '薇尔莉特');
    expect(ranked[0].title).toBe('薇尔莉特 台词合集');
    expect(ranked[1].score).toBeLessThan(ranked[0].score);
  });

  it('时长过短或过长的降权', () => {
    const good = candidate({ title: '绫波丽 语音合集', durationSeconds: 600 });
    const tooShort = candidate({ title: '绫波丽 语音合集', durationSeconds: 15 });
    const tooLong = candidate({ title: '绫波丽 语音合集', durationSeconds: 3600 });
    const ranked = rankVoiceCandidates([tooShort, tooLong, good], '绫波丽');
    expect(ranked[0].durationSeconds).toBe(600);
  });

  it('名字带分隔符时拆片段匹配', () => {
    const ranked = rankVoiceCandidates(
      [candidate({ title: '辛 诺赞 语录' }), candidate({ title: '完全无关的视频' })],
      '辛・诺赞',
    );
    expect(ranked[0].title).toBe('辛 诺赞 语录');
  });

  it('带作品名时，同名的其他作品角色被压到后面', () => {
    // 实测搜「蕾娜 语音」时前几条全是《魔女之旅》的伊蕾娜，跟 86 的蕾娜无关
    const ranked = rankVoiceCandidates(
      [
        candidate({ title: '伊蕾娜语音合成：Cosy voice还是Gpt-sovits', durationSeconds: 159, play: 1684 }),
        candidate({ title: '【86 不存在的战区】蕾娜 台词合集', durationSeconds: 200, play: 5000 }),
      ],
      '蕾娜',
      ['86 不存在的战区'],
    );
    expect(ranked[0].title).toContain('86');
  });

  it('作品名拆分后模糊匹配（《86 不存在的战区》→ 86 / 不存在的战区）', () => {
    const withWork = candidate({ title: '不存在的战区 蕾娜 语录', durationSeconds: 200 });
    const without = candidate({ title: '蕾娜 语录', durationSeconds: 200 });
    const ranked = rankVoiceCandidates([without, withWork], '蕾娜', ['86 不存在的战区']);
    expect(ranked[0].title).toBe('不存在的战区 蕾娜 语录');
  });

  it('标题里的 mod 按词边界降权，不误伤 model', () => {
    const mod = rankVoiceCandidates([candidate({ title: '蕾娜 舰桥播报mod' })], '蕾娜')[0].score;
    const model = rankVoiceCandidates([candidate({ title: '蕾娜 model 展示' })], '蕾娜')[0].score;
    expect(model).toBeGreaterThan(mod);
  });

  it('语音合成/AI 翻唱这类合成音要降权', () => {
    const ranked = rankVoiceCandidates(
      [
        candidate({ title: '蕾娜语音合成教程', durationSeconds: 200 }),
        candidate({ title: '蕾娜 台词合集', durationSeconds: 200 }),
      ],
      '蕾娜',
    );
    expect(ranked[0].title).toBe('蕾娜 台词合集');
  });

  it('不改动入参，返回新数组', () => {
    const input = [candidate({ title: 'B' }), candidate({ title: 'A' })];
    const snapshot = input.map((c) => c.title);
    const ranked = rankVoiceCandidates(input, 'X');
    expect(input.map((c) => c.title)).toEqual(snapshot);
    expect(ranked).not.toBe(input);
  });

  it('空列表不崩', () => {
    expect(rankVoiceCandidates([], '芙莉莲')).toEqual([]);
  });
});
