/**
 * core/ai-tools — 工具调用的共享类型与安全解析
 *
 * 放这里而不是 server/ 或 features/，是因为服务端与浏览器都要用同一套形状：
 *   服务端负责转发与 SSE 增量拼接，浏览器负责把模型的调用变成真正的 skill 执行。
 * 两边各写一份接口名，迟早会在字段命名上对不上。
 *
 * 一条原则贯穿全文件：**模型给的参数一律当不可信输入**。
 * 它可能给空串、半截 JSON、用中文引号、带 ``` 包裹，甚至给一个根本不存在的字段。
 * 所以这里的解析只做「尽力而为的宽松解析」，真正的字段校验交给 registry 的
 * `modelInputs` 白名单去过滤 —— 解析成功不等于参数可用。
 */

/** 模型请求的一次工具调用 */
export interface AIToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（未校验） */
  arguments: string;
}

/** OpenAI 风格的工具定义 */
export interface AIToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type AIToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };

/**
 * 宽松解析工具参数。
 *
 * 空字符串当作 `{}` —— 无参工具在多数网关上参数就是空串而不是 `"{}"`，
 * 这种情况不该算失败。
 */
export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw || '').trim();
  if (!text) return { ok: true, value: {} };

  // 去掉 ```json 包裹：模型明明说了"只输出 JSON"，还是经常包一层
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const candidates = [unfenced];
  // 前后有废话时，截取第一个 { 到最后一个 }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch { /* 换下一个候选 */ }
  }
  return { ok: false, error: `参数不是合法 JSON：${text.slice(0, 120)}` };
}

/**
 * 按白名单挑出模型真正可以决定的字段。
 *
 * 这是「模型碰不到数字」的落地点：即使模型给了 `score: 9.9`，只要它不在
 * `allowed` 里就会被丢掉；skill 内部再来一遍本地重算。
 */
export function pickAllowedArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  if (allowed.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(args, key)) out[key] = args[key];
  }
  return out;
}
