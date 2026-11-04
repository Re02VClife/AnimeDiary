/**
 * core/tag-name — 标签名的归一化
 *
 * 为什么需要：批量打标签让模型凭空造标签之后，库里出现了「看着一样、实际是两个」
 * 的标签 —— `科幻` 和 `科幻 `（尾巴带空格）、`３D动画` 和 `3D动画`（全角/半角）。
 * 计数被劈成两半（18 和 10），筛选点了其中一个也筛不全。
 *
 * 所以「同一个标签」不能按字符串相等判断，要按归一化后的结果判断。
 *
 * 注意归一化**只用于比较和展示**，不直接改数据 —— 真正把数据统一要靠重命名/删除，
 * 那是用户的选择（`handleRenameTag` 会重写所有引用）。
 */

/** 零宽字符（模型偶尔会吐出来，肉眼完全看不见） */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * 标签名归一化：
 *   - 去掉零宽字符（不可见，最阴的一类）
 *   - NFKC：全角字母数字 → 半角（`３D动画` → `3D动画`）
 *   - 首尾去空白，中间连续空白压成一个
 */
export function normalizeTagName(name: string): string {
  if (!name) return '';
  return name
    .replace(ZERO_WIDTH, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 两个标签名是不是同一个（按归一化判断） */
export function sameTagName(a: string, b: string): boolean {
  return normalizeTagName(a) === normalizeTagName(b);
}

/**
 * 把标签列表按归一化后的名字聚合成计数。
 *
 * `label` 取**用得最多的那个原始写法**（而不是归一化后的），
 * 这样界面上显示的还是用户自己惯用的形态，不会突然把 `３D动画` 改成 `3D动画`。
 */
export interface TagGroup {
  /** 归一化键 */
  key: string;
  /** 展示用的原始写法（出现次数最多的那个） */
  label: string;
  /** 合并后的总计数 */
  count: number;
  /** 这一组实际出现过的原始写法（筛选时要全都匹配上） */
  variants: string[];
}

export interface DuplicateSuggestion {
  /** 建议保留的（用得多的那个） */
  keep: TagGroup;
  /** 建议并入的（用得少的那个） */
  merge: TagGroup;
}

/** 左边是右边「从头开始」的缩写（`漫改` 之于 `漫画改`、`轻改` 之于 `轻小说改`） */
function isLeadingAbbreviation(short: string, long: string): boolean {
  if (!short || !long || !long.startsWith(short[0])) return false;
  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i++;
    if (i === short.length) return true;
  }
  return false;
}

/** 两个名字都至少有 3 次使用才值得提示；10 个的阈值见下方注释 */
const DUPLICATE_MIN_COUNT = 3;
/** 长度差上限：差太多基本是两个概念 */
const DUPLICATE_MAX_LENGTH_DIFF = 3;

/**
 * 找出**疑似**重复的标签对，供 UI 提示。
 *
 * 判据是「从头开始的缩写」，而不是语义相似：
 *   - 前缀：`群像` / `群像剧`、`原创` / `原创动画`
 *   - 缩写：`漫改` / `漫画改`、`轻改` / `轻小说改` —— 缩写不是前缀，但字符按顺序
 *     都能在长名字里找到，**且必须从第一个字开始**
 *
 * 最后那条「从头开始」很关键。只用「子序列」的话会把 `反青春` 判成 `青春` 的变体
 * （意思正好相反）、把 `昭和日常` 判成 `日常`（那是限定词，不是缩写）。
 *
 * 阈值是在用户真实的 724 个标签上调出来的：
 *   - 不设下限（≥1）→ 124 组，全是「未来日常/公寓日常」这种长尾噪音
 *   - ≥3 且长度差 ≤3 → **10 组**，正好是「漫改/漫画改」「群像/群像剧」这些该看的
 *
 * `京都动画/京阿尼`、`3D动画/三维动画` 这类纯同义词抓不到 —— 那需要同义词表，
 * 硬猜会误伤（`短片` 和 `短篇` 看着像，其实是两个概念）。所以这里只**建议**，
 * 按下合并键的永远是用户，绝不自动执行。
 */
export function findLikelyDuplicates(groups: TagGroup[]): DuplicateSuggestion[] {
  const out: DuplicateSuggestion[] = [];
  const seen = new Set<string>();

  for (const a of groups) {
    for (const b of groups) {
      if (a.key === b.key) continue;
      if (a.count < DUPLICATE_MIN_COUNT || b.count < DUPLICATE_MIN_COUNT) continue;

      const [short, long] = a.label.length <= b.label.length ? [a, b] : [b, a];
      if (short.label.length < 2) continue;
      const extra = long.label.length - short.label.length;
      if (extra <= 0 || extra > DUPLICATE_MAX_LENGTH_DIFF) continue;
      if (!isLeadingAbbreviation(short.label, long.label)) continue;

      const keep = a.count >= b.count ? a : b;
      const merge = keep === a ? b : a;
      const pairKey = [keep.key, merge.key].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      out.push({ keep, merge });
    }
  }

  // 影响大的排前面：两个计数之和越大，合并收益越高
  return out.sort((x, y) => (y.keep.count + y.merge.count) - (x.keep.count + x.merge.count));
}

export function groupTagNames(entries: Iterable<string>): TagGroup[] {
  const raw = new Map<string, number>(); // 原始写法 → 次数
  for (const name of entries) {
    const trimmed = name ?? '';
    if (!trimmed) continue;
    raw.set(trimmed, (raw.get(trimmed) || 0) + 1);
  }

  const groups = new Map<string, { total: number; byRaw: Map<string, number> }>();
  for (const [name, n] of raw) {
    const key = normalizeTagName(name);
    if (!key) continue;
    const g = groups.get(key) || { total: 0, byRaw: new Map<string, number>() };
    g.total += n;
    g.byRaw.set(name, (g.byRaw.get(name) || 0) + n);
    groups.set(key, g);
  }

  const out: TagGroup[] = [];
  for (const [key, g] of groups) {
    // 展示写法：用得多优先，次数相同则取更短的那个（`科幻` 优于 `科幻 `）
    const variants = [...g.byRaw.keys()].sort((a, b) => {
      const diff = (g.byRaw.get(b) || 0) - (g.byRaw.get(a) || 0);
      if (diff !== 0) return diff;
      return a.length - b.length || a.localeCompare(b, 'zh');
    });
    out.push({ key, label: variants[0], count: g.total, variants });
  }
  return out;
}
