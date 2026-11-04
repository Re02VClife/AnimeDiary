/**
 * core/voice-search — 角色语音候选的纯逻辑（无网络）
 *
 * 搜索结果是「别人剪的视频」，标题是否真的对应这个角色、内容是不是台词合集，
 * 全靠这里打分排序。实测 B 站上「角色名 + 语音/台词」的命中率很高，
 * 但也混着翻唱、声线教学、MAD、鬼畜，必须排到后面去。
 */

export interface VoiceCandidate {
  bvid: string;
  title: string;
  /** 视频时长（秒） */
  durationSeconds: number;
  /** 播放量 */
  play: number;
  author: string;
  coverUrl: string | null;
  pageUrl: string;
  /** 相对相关度，越大越可能是「这个角色的台词合集」 */
  score: number;
}

/** B 站搜索的 duration 字段有 "4:25" / "690:23" / 秒数 三种形态，统一成秒 */
export function parseBiliDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (!text) return 0;
  // 纯数字 = 已是秒
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * 标题里出现这些词，基本可以确定不是「角色本人在说话」。
 *
 * 「语音包」单独列出来是因为实测搜「芙莉莲 语音」时，排第一的是
 * 「【战争雷霆】葬送的芙莉莲语音包」—— 那是给游戏换语音的 mod，
 * 片段碎、还有游戏音效，拿来当角色语音体验很差。
 */
const NEGATIVE_TITLE = [
  '翻唱', '声线', '教你', '怎么学', '模仿', 'cosplay', '鬼畜', 'MAD', 'AMV',
  '混剪', '剪辑教程', '配音教学', 'AI配音', 'ai翻唱', '男声版', '女声版',
  '演奏', '钢琴', '吉他', 'BGM', 'mmd', 'MMD', '手书', '漫画解说', 'reaction', 'React',
  '语音包', '替换包', 'mod介绍', '语音合成',
];

/**
 * 「mod」要按词边界判断：中文标题里它是夹在汉字之间的（「86蕾娜舰桥播报mod」），
 * 直接用 includes 会把 model / modern 这类词也算进来。
 */
const MOD_PATTERN = /\bmods?\b/i;

/** 明确指向「这个角色在说台词」的词，权重最高 */
const STRONG_TITLE = ['台词', '语录', '纯享', '合集', '收录', '名场面', 'ボイス'];

/** 只是沾边（可能是别人的语音、也可能是素材包），权重低 */
const WEAK_TITLE = ['语音', '配音', '素材'];

/** 太短的凑不出 30 秒，太长的下载要等很久（也更容易混进整段剧情） */
const MIN_DURATION = 20;
const MAX_DURATION = 60 * 30;

/**
 * 给候选视频打分并排序。
 *
 * 分数只用于「谁排前面」，不追求绝对正确 —— 界面上始终显示标题、时长、
 * 播放量和 UP 主，由人最后点一下确认。
 *
 * workTitles 是角色的「所属作品」：同名角色太多了（实测搜「蕾娜 语音」，
 * 前几条全是《魔女之旅》的伊蕾娜和《超神学院》的女神蕾娜，跟 86 的蕾娜
 * 一点关系都没有），带上作品名才能把范围收窄。
 */
export function rankVoiceCandidates(
  candidates: VoiceCandidate[],
  characterName: string,
  workTitles: string[] = [],
): VoiceCandidate[] {
  const role = String(characterName ?? '').trim();
  // 角色名常带「・」和空格，标题里可能写成别的分隔方式，拆成片段分别匹配
  const tokens = role.split(/[\s・·]+/).filter((t) => t.length >= 1);
  // 作品名同样要拆：《86 不存在的战区》在标题里常写成「86-不存在的战区」
  const workTokens = [...new Set(
    workTitles
      .flatMap((w) => String(w ?? '').split(/[\s・·《》「」【】()（）\-_/]+/))
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  )];
  const scored = candidates.map((item) => {
    let score = 0;
    const title = String(item.title ?? '');

    // 相关性是硬门槛：标题里连角色名都没有的视频，不能因为播放量高就排到
    // 有角色名的结果前面（否则「今天吃什么」这种热门视频会挤掉真正的台词合集）。
    //
    // 但简称要留活路：搜「雷电将军」时「雷神全好感语音」标题里没有全名，
    // 却确实是这个角色的语音。所以用「标题里有没有语音/台词这类词」做弱信号 ——
    // 有就只是降权，没有才压到底。
    const nameScore = role && title.includes(role)
      ? 12
      : tokens.length > 0 && tokens.every((t) => title.includes(t))
        ? 8
        : tokens.some((t) => t.length >= 2 && title.includes(t))
          ? 3
          : 0;

    if (nameScore > 0) score += nameScore;
    else {
      const looksLikeVoice = [...STRONG_TITLE, ...WEAK_TITLE].some((w) => title.includes(w));
      score -= looksLikeVoice ? 8 : 20;
    }

    // 作品名是最强的消歧信号：「蕾娜」在《86》《魔女之旅》《超神学院》里都有，
    // 只有带上作品名才知道指的是哪一个。命中越多分越高，全都对不上就降权。
    const workHits = workTokens.filter((t) => title.includes(t)).length;
    if (workHits > 0) score += Math.min(12, workHits * 7);
    else if (workTokens.length > 0) score -= 4;

    // 命中的词按强弱分级：标题写「台词合集」比只写「语音」可信得多，
    // 但同义词会互相包含（「经典台词」同时命中「台词」），所以各自封顶
    const strongHits = STRONG_TITLE.filter((w) => title.includes(w)).length;
    const weakHits = WEAK_TITLE.filter((w) => title.includes(w)).length;
    score += Math.min(12, strongHits * 6) + Math.min(4, weakHits * 2);
    for (const word of NEGATIVE_TITLE) if (title.includes(word)) score -= 8;
    if (MOD_PATTERN.test(title)) score -= 8;

    // 时长：1~12 分钟最像语音合集/语录；超出这个范围收益递减
    const d = item.durationSeconds;
    if (d >= 60 && d <= 720) score += 6;
    else if (d >= MIN_DURATION && d < 60) score += 2;
    else if (d > 720 && d <= MAX_DURATION) score += 1;
    else score -= 6;

    // 播放量取对数：几千播放足够说明内容可用，百万播放的反而常是 MAD
    if (item.play > 0) score += Math.min(4, Math.log10(item.play) - 1);

    return { ...item, score: Number(score.toFixed(2)) };
  });

  return scored.sort((a, b) => b.score - a.score);
}
