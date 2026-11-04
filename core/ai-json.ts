/**
 * core/ai-json — LLM 结构化输出的「解析 → 修复 → 校验」纯函数
 *
 * 为什么需要这一层：
 *   1. 模型会把 JSON 包在 ```json 代码块里，或前后加一句"好的，以下是分析："；
 *   2. 小模型/推理模型被 max_tokens 截断，只吐出半个对象；
 *   3. 字段类型漂移：confidence 输出成 "0.9"、highlights 只有一条时输出成字符串；
 *   4. 字段缺失、多出未声明的字段。
 *   —— 直接 JSON.parse 会抛异常，整条分析链就报废了，用户只看到"分析失败"。
 *
 * 本文件只做纯计算，不碰网络/存储，被 tsc 检查并有单测。
 */

export type JSONSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** 只支持实际用到的 JSON Schema 子集（够描述所有 Skill 的输出） */
export interface JSONSchema {
  type?: JSONSchemaType;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
}

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────
// 1. 从任意文本里抠出 JSON 片段
// ─────────────────────────────────────────────────────────────

/** 第一个 `{` 或 `[` 的位置（取更早的那个） */
function firstBracket(text: string): number {
  const a = text.indexOf('{');
  const b = text.indexOf('[');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/**
 * 从 start（必须是 `{` / `[`）开始做括号配对，跳过字符串内部与转义字符。
 * 找不到闭合时返回 -1（调用方据此判断"被截断"）。
 */
function matchBracketEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (!open) return -1;
      if (open === '{' && ch !== '}') return -1;
      if (open === '[' && ch !== ']') return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** 从模型原始输出中提取 JSON 文本（去代码块、去前后废话、按括号配对截取） */
export function extractJSONText(raw: string): string {
  if (!raw) return '';
  let text = String(raw).replace(/^\uFEFF/, '').trim();
  if (!text) return '';

  // ```json ... ``` 包裹：取带花括号的第一段
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && /[[{]/.test(fenced[1])) text = fenced[1].trim();

  const start = firstBracket(text);
  if (start < 0) return text;

  const end = matchBracketEnd(text, start);
  // 配不上对 = 被截断，返回剩余部分让解析器给出"未闭合"错误
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

// ─────────────────────────────────────────────────────────────
// 2. 宽松解析（容错常见畸形）
// ─────────────────────────────────────────────────────────────

/** 去掉对象/数组末尾多余的逗号 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      // 向前找下一个非空白字符，若是 } 或 ] 则丢弃这个逗号
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** 中文引号/全角冒号是模型常见的输出走样，做一次保守替换 */
function normalizePunctuation(text: string): string {
  return text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/：(\s*)/g, ': ')
    .replace(/，(?=\s*[\n"\]}])/g, ',');
}

function isBalancedJSON(text: string): boolean {
  const start = firstBracket(text);
  if (start < 0) return !/[{}[\]]/.test(text) ? true : false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
  }
  return depth === 0 && !inString;
}

export function parseLooseJSON(raw: string): ParseResult {
  const text = extractJSONText(raw);
  if (!text) return { ok: false, error: '模型输出为空' };

  const candidates = [
    text,
    stripTrailingCommas(text),
    normalizePunctuation(stripTrailingCommas(text)),
  ];

  let lastError = '';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // 给出可回传给模型的自纠提示
  const hint = !isBalancedJSON(text)
    ? '（输出在对象结束前被截断，请缩短内容或减少条目）'
    : '';
  return { ok: false, error: `JSON 解析失败：${lastError}${hint}` };
}

// ─────────────────────────────────────────────────────────────
// 3. 按 Schema 纠偏（先修再校验，能修的不必再问模型）
// ─────────────────────────────────────────────────────────────

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 单个值向目标类型靠拢（只做无损/低风险转换，失败原样返回） */
function coerceValue(value: unknown, schema: JSONSchema): unknown {
  const t = schema.type;
  if (!t) return value;

  if (t === 'array') {
    // 只有一条时模型经常直接给标量 → 包成数组
    if (!Array.isArray(value)) {
      if (value === null || value === undefined) return [];
      return [value];
    }
    return value.map((v) => (schema.items ? coerceValue(v, schema.items) : v));
  }

  if (t === 'object') {
    if (typeName(value) !== 'object') return value;
    return sanitizeBySchema(value, schema);
  }

  if (t === 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return value;
  }

  if (t === 'number' || t === 'integer') {
    let n: number | null = null;
    if (typeof value === 'number' && Number.isFinite(value)) n = value;
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      n = Number(value);
    }
    if (n === null) return value;
    if (t === 'integer') n = Math.round(n);
    if (typeof schema.minimum === 'number') n = Math.max(schema.minimum, n);
    if (typeof schema.maximum === 'number') n = Math.min(schema.maximum, n);
    return n;
  }

  if (t === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }

  return value;
}

/**
 * 递归纠偏：补类型、修数组/标量、按 minimum/maximum 夹紧、
 * additionalProperties=false 时删掉多余字段。
 */
export function sanitizeBySchema(value: unknown, schema: JSONSchema): unknown {
  if (value === undefined || value === null) return value;

  if (schema.type === 'array') {
    const arr = Array.isArray(value) ? value : [value];
    return arr.map((v) => (schema.items ? coerceValue(v, schema.items) : v));
  }

  if (schema.type === 'object') {
    if (typeName(value) !== 'object') return value;
    const input = value as Record<string, unknown>;
    const props = schema.properties || {};
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(input)) {
      if (schema.additionalProperties === false && !(key in props)) continue;
      out[key] = props[key] ? coerceValue(v, props[key]) : v;
    }
    // 可选数组字段缺失时补空数组，UI 不必层层判空
    for (const [key, sub] of Object.entries(props)) {
      if (!(key in out) && sub.type === 'array' && !schema.required?.includes(key)) {
        out[key] = [];
      }
    }
    return out;
  }

  return coerceValue(value, schema);
}

// ─────────────────────────────────────────────────────────────
// 4. 校验
// ─────────────────────────────────────────────────────────────

/** 返回错误列表（空数组 = 通过）。路径形如 `$.likes[2].confidence` */
export function validateSchema(
  value: unknown,
  schema: JSONSchema,
  path = '$',
): string[] {
  const errors: string[] = [];
  const t = schema.type;

  if (t === 'object') {
    if (typeName(value) !== 'object') {
      return [`${path}: 期望 object，实际 ${typeName(value)}`];
    }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (obj[key] === undefined || obj[key] === null) {
        errors.push(`${path}.${key}: 缺少必填字段`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (obj[key] === undefined) continue;
      errors.push(...validateSchema(obj[key], sub, `${path}.${key}`));
    }
    return errors;
  }

  if (t === 'array') {
    if (!Array.isArray(value)) {
      return [`${path}: 期望 array，实际 ${typeName(value)}`];
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateSchema(item, schema.items!, `${path}[${i}]`));
      });
    }
    return errors;
  }

  if (t === 'string' && typeof value !== 'string') {
    return [`${path}: 期望 string，实际 ${typeName(value)}`];
  }
  if (t === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return [`${path}: 期望 number，实际 ${typeName(value)}`];
  }
  if (t === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
    return [`${path}: 期望 integer，实际 ${typeName(value)}`];
  }
  if (t === 'boolean' && typeof value !== 'boolean') {
    return [`${path}: 期望 boolean，实际 ${typeName(value)}`];
  }
  if (t === 'null' && value !== null) {
    return [`${path}: 期望 null，实际 ${typeName(value)}`];
  }

  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    errors.push(`${path}: 取值 ${JSON.stringify(value)} 不在允许范围内`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} 小于最小值 ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: ${value} 大于最大值 ${schema.maximum}`);
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────
// 5. Schema → 提示词里的字段说明
// ─────────────────────────────────────────────────────────────

/** 把 Schema 压成给模型看的一行行字段说明（比让模型读 JSON Schema 更稳） */
export function describeSchema(schema: JSONSchema, indent = ''): string {
  const lines: string[] = [];
  const required = new Set(schema.required || []);

  const walk = (s: JSONSchema, name: string, depth: number): void => {
    const pad = '  '.repeat(depth);
    const mark = required.has(name) ? '必填' : '可选';
    const desc = s.description ? ` — ${s.description}` : '';
    lines.push(`${pad}${name}: ${s.type || 'any'}（${mark}）${desc}`);
    if (s.type === 'object' && s.properties) {
      for (const [key, sub] of Object.entries(s.properties)) {
        walk(sub, key, depth + 1);
      }
    } else if (s.type === 'array' && s.items) {
      if (s.items.type === 'object' && s.items.properties) {
        lines.push(`${pad}  每项字段：`);
        for (const [key, sub] of Object.entries(s.items.properties)) {
          walk(sub, key, depth + 2);
        }
      } else {
        lines.push(`${pad}  每项: ${s.items.type || 'any'}`);
      }
    }
  };

  for (const [key, sub] of Object.entries(schema.properties || {})) {
    walk(sub, key, indent ? 1 : 0);
  }
  return lines.join('\n');
}
