/**
 * core/ai-tools 单测
 *
 * 这两条函数处理的都是「模型给的东西」：
 *   parseToolArguments 要能容忍模型的各种不规范输出
 *   pickAllowedArgs    要能挡住模型塞进来的越权字段（比如偷偷给一个 score）
 */
import { describe, it, expect } from 'vitest';
import { parseToolArguments, pickAllowedArgs } from '../../core/ai-tools';

describe('parseToolArguments', () => {
  it('空串当作无参数（无参工具在网关上就是空串）', () => {
    expect(parseToolArguments('')).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('   ')).toEqual({ ok: true, value: {} });
  });

  it('正常 JSON 对象', () => {
    expect(parseToolArguments('{"title":"86"}')).toEqual({ ok: true, value: { title: '86' } });
  });

  it('去掉 ```json 代码块包裹', () => {
    const r = parseToolArguments('```json\n{"title":"86"}\n```');
    expect(r).toEqual({ ok: true, value: { title: '86' } });
  });

  it('前后有废话时截取花括号之间', () => {
    const r = parseToolArguments('好的，参数是 {"title":"86"} 请查收');
    expect(r).toEqual({ ok: true, value: { title: '86' } });
  });

  it('数组不算合法参数（工具参数必须是对象）', () => {
    const r = parseToolArguments('[1,2]');
    expect(r.ok).toBe(false);
  });

  it('半截 JSON 报错而不是静默返回空对象', () => {
    const r = parseToolArguments('{"title":"86"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('JSON');
  });

  it('非 JSON 文本报错', () => {
    expect(parseToolArguments('随便说点什么').ok).toBe(false);
  });
});

describe('pickAllowedArgs', () => {
  it('只保留白名单字段', () => {
    const picked = pickAllowedArgs({ title: '86', score: 9.9, id: 'fake-1' }, ['title']);
    expect(picked).toEqual({ title: '86' });
  });

  it('白名单为空时一个字段都不放行', () => {
    expect(pickAllowedArgs({ title: '86' }, [])).toEqual({});
  });

  it('缺失的字段不会凭空补出来', () => {
    expect(pickAllowedArgs({}, ['title'])).toEqual({});
  });

  it('不会把原型链上的名字当成参数', () => {
    const picked = pickAllowedArgs({ title: '86' }, ['constructor', 'toString']);
    expect(picked).toEqual({});
  });
});
