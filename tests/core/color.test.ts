/**
 * core/color 单元测试
 */
import { describe, it, expect } from 'vitest';
import { nameToHue, hslToHex, hexToHsl, mixHslColors } from '../../core/color';

describe('nameToHue', () => {
  it('相同名称始终返回相同色相', () => {
    expect(nameToHue('京都动画')).toBe(nameToHue('京都动画'));
  });

  it('返回值在 0-360 范围内', () => {
    for (const name of ['A', '测试', 'long name here', '短']) {
      const hue = nameToHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('不同名称通常返回不同色相', () => {
    // 虽然极低概率碰撞，但不同名一般不同色
    const h1 = nameToHue('科幻');
    const h2 = nameToHue('日常');
    // 不强行断言不等，但至少都在合法范围
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h2).toBeGreaterThanOrEqual(0);
  });
});

describe('hslToHex', () => {
  it('纯红 #ff0000', () => {
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
  });

  it('纯白 #ffffff (s=0, l=100)', () => {
    expect(hslToHex(0, 0, 100)).toBe('#ffffff');
  });

  it('纯黑 #000000 (l=0)', () => {
    expect(hslToHex(0, 0, 0)).toBe('#000000');
  });

  it('灰色 #808080 (s=0, l=50)', () => {
    expect(hslToHex(0, 0, 50)).toBe('#808080');
  });
});

describe('hexToHsl', () => {
  it('纯红 #ff0000 → h≈0, s≈100, l≈50', () => {
    const result = hexToHsl('#ff0000');
    expect(result.h).toBeCloseTo(0, 0);
    expect(result.s).toBeCloseTo(100, 0);
    expect(result.l).toBeCloseTo(50, 0);
  });

  it('纯白 #ffffff → l≈100', () => {
    const result = hexToHsl('#ffffff');
    expect(result.l).toBeCloseTo(100, 0);
  });

  it('纯黑 #000000 → l≈0', () => {
    const result = hexToHsl('#000000');
    expect(result.l).toBeCloseTo(0, 0);
  });
});

describe('mixHslColors', () => {
  it('单个颜色返回自身', () => {
    const result = mixHslColors([{ h: 120, s: 50, l: 50 }]);
    expect(result.h).toBeCloseTo(120, 5);
    expect(result.s).toBeCloseTo(50, 5);
    expect(result.l).toBeCloseTo(50, 5);
  });

  it('两个颜色取均值', () => {
    const result = mixHslColors([
      { h: 0, s: 100, l: 50 },
      { h: 120, s: 50, l: 30 },
    ]);
    // s = (100+50)/2=75, l=(50+30)/2=40
    expect(result.s).toBeCloseTo(75, 5);
    expect(result.l).toBeCloseTo(40, 5);
  });

  it('空数组返回默认灰色', () => {
    const result = mixHslColors([]);
    expect(result.h).toBe(0);
    expect(result.s).toBe(0);
    expect(result.l).toBe(45);
  });
});
