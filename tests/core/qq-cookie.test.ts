/**
 * core/qq-cookie 单测
 *
 * 这块逻辑只有两个「错了就白折腾」的地方：
 *   1. 用户粘贴的形态千奇百怪（整条请求头 / 换行 / 只挑两个键），必须都能认；
 *   2. uin 可能是 `o0123456789`，vkey 要的却是纯数字 —— 转换错了就拿不到 purl。
 */
import { describe, expect, it } from 'vitest';
import { maskUin, parseQqCookie, QqCookieError } from '../../core/qq-cookie';

describe('parseQqCookie', () => {
  it('认整条 Cookie 请求头，并丢掉无关键', () => {
    const parsed = parseQqCookie(
      'pgv_pvid=1234567890; uin=o0123456789; qm_keyst=abcDEF123; qqmusic_key=abcDEF123; ts_uid=987',
    );
    expect(parsed.uin).toBe('0123456789');
    expect(parsed.rawUin).toBe('o0123456789');
    expect(parsed.keys).toContain('qm_keyst');
    expect(parsed.cookie).toContain('qm_keyst=abcDEF123');
    expect(parsed.cookie).not.toContain('pgv_pvid');
    expect(parsed.cookie).not.toContain('ts_uid');
  });

  it('认换行分隔的粘贴', () => {
    const parsed = parseQqCookie('uin=o123456\nqm_keyst=xyz\n');
    expect(parsed.uin).toBe('123456');
    expect(parsed.cookie).toBe('uin=o123456; qm_keyst=xyz');
  });

  it('只有 qqmusic_key 也认（部分浏览器只存这个）', () => {
    const parsed = parseQqCookie('uin=o999; qqmusic_key=kkk');
    expect(parsed.keys).toContain('qqmusic_key');
  });

  it('容忍 Cookie: 前缀与多余空格', () => {
    const parsed = parseQqCookie('Cookie: uin=o42 ;  qm_keyst=kk ');
    expect(parsed.uin).toBe('42');
    expect(parsed.cookie).toContain('qm_keyst=kk');
  });

  it('缺 keyst 时说清楚该去哪个域名复制', () => {
    expect(() => parseQqCookie('uin=o123; skey=abc')).toThrow(QqCookieError);
    expect(() => parseQqCookie('uin=o123; skey=abc')).toThrow(/qm_keyst/);
  });

  it('缺 uin 时拒绝（vkey 没有 uin 一定拿不到会员音源）', () => {
    expect(() => parseQqCookie('qm_keyst=abc')).toThrow(/uin/);
  });

  it('空输入直接报错，不返回半个对象', () => {
    expect(() => parseQqCookie('   ')).toThrow(QqCookieError);
  });
});

describe('maskUin', () => {
  it('只露头尾几位', () => {
    expect(maskUin('0123456789')).toBe('012****789');
    expect(maskUin('123')).toBe('****');
    expect(maskUin('')).toBe('');
  });
});
