/**
 * core/text — 文本处理工具函数
 *   纯函数，零业务耦合，可跨项目复用
 */

/** 从 LLM 原始输出中提取 JSON（处理 markdown 代码块包裹等） */
export function extractJSON(raw: string): string {
  // 去掉 ```json ... ``` 包裹
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim();
  // 尝试找到第一个 { 到最后一个 }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

/** 安全截断字符串，超出长度尾部加省略号 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

/** 中文停用词集合 */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '但',
  '而', '且', '或', '与', '及', '之', '为', '以', '可以', '这个', '那个',
  '还', '更', '最', '被', '把', '从', '让', '对', '所以', '因为', '如果',
  '虽然', '但是', '然而', '然后', '于是', '因此', '不过', '只是', '觉得',
  '感觉', '真的', '非常', '比较', '特别', '一些', '很多', '这部', '这部番',
  '番', '动漫', '动画', '作品', '剧情', '角色', '制作', '画面', '音乐',
]);

/**
 * 简单中文分词 + 关键词提取（基于频次统计，不依赖 LLM）
 * @param texts 待分析文本列表
 * @param topN 返回前 N 个关键词，默认 20
 */
export function extractKeywords(texts: string[], topN: number = 20): string[] {
  const wordFreq: Record<string, number> = {};
  for (const text of texts) {
    // 按标点/空格分割
    const segments = text.split(
      /[，,。.!！？?、；;：:（）()【】\[\]""''\s\n\r]+/,
    );
    for (const seg of segments) {
      if (!seg || seg.length < 2 || seg.length > 8) continue;
      if (STOP_WORDS.has(seg)) continue;
      wordFreq[seg] = (wordFreq[seg] || 0) + 1;
    }
  }

  return Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

/** 解析分隔符连接的标签字符串（"/" 或 "、" 分隔），返回标签名数组 */
export function parseTagString(raw: string): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[/、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
