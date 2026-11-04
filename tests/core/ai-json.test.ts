/**
 * core/ai-json 单测 —— LLM 输出千奇百怪，这一层是最后一道闸
 */
import { describe, it, expect } from 'vitest';
import {
  extractJSONText,
  parseLooseJSON,
  sanitizeBySchema,
  validateSchema,
  describeSchema,
} from '../../core/ai-json';
import type { JSONSchema } from '../../core/ai-json';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    likes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aspect: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['aspect', 'confidence'],
        additionalProperties: false,
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'likes'],
  additionalProperties: false,
};

describe('extractJSONText', () => {
  it('剥掉 markdown 代码块', () => {
    expect(extractJSONText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥掉前后废话', () => {
    const raw = '好的，以下是分析结果：\n{"a":1}\n希望有帮助！';
    expect(extractJSONText(raw)).toBe('{"a":1}');
  });

  it('字符串里的花括号不影响配对', () => {
    const raw = '{"summary":"他说「{这是引号里的}」","likes":[]}';
    expect(JSON.parse(extractJSONText(raw))).toEqual({ summary: '他说「{这是引号里的}」', likes: [] });
  });

  it('被截断时返回剩余部分（交给解析器报错）', () => {
    const raw = '{"summary":"还没写完';
    expect(extractJSONText(raw)).toBe('{"summary":"还没写完');
  });
});

describe('parseLooseJSON', () => {
  it('容忍末尾逗号', () => {
    const r = parseLooseJSON('{"a":1,"b":[1,2,],}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1, b: [1, 2] });
  });

  it('容忍中文引号', () => {
    const r = parseLooseJSON('{“summary”:“好的”}');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { summary: string }).summary).toBe('好的');
  });

  it('空输出给出明确错误', () => {
    const r = parseLooseJSON('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('为空');
  });

  it('截断的 JSON 报错并提示被截断', () => {
    const r = parseLooseJSON('{"summary":"x","likes":[{"aspect":"y"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/截断|Unterminated|Unexpected/);
  });
});

describe('sanitizeBySchema', () => {
  it('单个对象自动包成数组', () => {
    const out = sanitizeBySchema({ summary: 's', likes: { aspect: 'a', confidence: 0.5 } }, SCHEMA) as any;
    expect(Array.isArray(out.likes)).toBe(true);
    expect(out.likes[0].aspect).toBe('a');
  });

  it('字符串数字转数字并夹紧范围', () => {
    const out = sanitizeBySchema(
      { summary: 's', likes: [{ aspect: 'a', confidence: '1.7' }] },
      SCHEMA,
    ) as any;
    expect(out.likes[0].confidence).toBe(1);
  });

  it('删掉未声明的字段', () => {
    const out = sanitizeBySchema(
      { summary: 's', likes: [], 无关字段: 'x' },
      SCHEMA,
    ) as any;
    expect(out.无关字段).toBeUndefined();
  });

  it('可选数组缺失时补空数组', () => {
    const out = sanitizeBySchema({ summary: 's', likes: [] }, SCHEMA) as any;
    expect(out.notes).toEqual([]);
  });
});

describe('validateSchema', () => {
  it('通过合法数据', () => {
    expect(validateSchema({ summary: 's', likes: [], notes: [] }, SCHEMA)).toEqual([]);
  });

  it('缺必填字段给出路径', () => {
    const errors = validateSchema({ likes: [] }, SCHEMA);
    expect(errors[0]).toContain('$.summary');
  });

  it('类型不符给出路径', () => {
    const errors = validateSchema({ summary: 1, likes: [] }, SCHEMA);
    expect(errors.some((e) => e.includes('$.summary'))).toBe(true);
  });
});

describe('describeSchema', () => {
  it('列出字段名和必填标记', () => {
    const text = describeSchema(SCHEMA);
    expect(text).toContain('summary');
    expect(text).toContain('必填');
    expect(text).toContain('likes');
  });
});
