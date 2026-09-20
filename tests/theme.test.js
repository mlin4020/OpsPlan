// 换肤（顶栏配色）测试：锁住主题表的完整性、可读性与持久化行为，
// 重点守住「任何一套主题上白字都必须达到 WCAG AA」这条硬约束。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HERO_THEMES, DEFAULT_THEME, getTheme, themeVars, isValidTheme, hexToHsl } from '../src/core/themes.js';
import { readStoredTheme, applyTheme, saveTheme, restoreTheme } from '../src/utils/theme.js';
import { buildShellHTML } from '../src/components/shell.js';

const HEX = /^#[0-9a-f]{6}$/i;

// WCAG 相对亮度
function luminance(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastWithWhite = hex => (1.05) / (luminance(hex) + 0.05);

// 最小 DOM 替身：applyTheme 只用到 documentElement.style / dataset 与 theme-color meta
function fakeDoc() {
  const vars = {};
  const meta = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  return {
    documentElement: {
      style: { setProperty: (k, v) => { vars[k] = v; } },
      dataset: {}
    },
    querySelector: sel => (sel === 'meta[name="theme-color"]' ? meta : null),
    _vars: vars,
    _meta: meta
  };
}

describe('themes: 主题表', () => {
  const SCALE = ['hero', 'heroDeep', 'heroSoft', 'accent', 'accentStrong', 'accentSoft', 'accentLine', 'accentInk'];

  it('提供 10 套配色，key 唯一且整套色阶都合法', () => {
    expect(HERO_THEMES).toHaveLength(10);
    expect(new Set(HERO_THEMES.map(t => t.key)).size).toBe(10);
    HERO_THEMES.forEach(t => {
      expect(t.name, t.key).toBeTruthy();
      SCALE.forEach(k => expect(t[k], `${t.key}.${k}`).toMatch(HEX));
      expect(t.accentRing, `${t.key}.accentRing`).toMatch(/^rgba\(\d+,\d+,\d+,\.\d+\)$/);
    });
  });

  it('每套主题的 hero 上白字对比度都达到 WCAG AA（≥4.5:1）', () => {
    HERO_THEMES.forEach(t => {
      const ratio = contrastWithWhite(t.hero);
      expect(ratio, `${t.name} ${t.hero} 对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('heroDeep 必须比 hero 深（否则桌面端渐变方向会反）', () => {
    HERO_THEMES.forEach(t => {
      expect(luminance(t.heroDeep), `${t.name} heroDeep 不够深`).toBeLessThan(luminance(t.hero));
    });
  });

  it('色阶方向正确：soft 比 accent 亮、ink/strong 比 accent 深', () => {
    HERO_THEMES.forEach(t => {
      const L = hex => luminance(hex);
      expect(L(t.accentSoft), `${t.name} accentSoft`).toBeGreaterThan(L(t.accent));
      expect(L(t.accentLine), `${t.name} accentLine`).toBeGreaterThan(L(t.accent));
      expect(L(t.accentInk), `${t.name} accentInk`).toBeLessThan(L(t.accent));
      expect(L(t.accentStrong), `${t.name} accentStrong`).toBeLessThan(L(t.accent));
    });
  });

  it('派生色只改明度、不改色相（否则 10 套主题会各偏一种色，像拼凑的）', () => {
    HERO_THEMES.forEach(t => {
      const h0 = hexToHsl(t.hero).h;
      ['heroDeep', 'accentStrong', 'accentInk'].forEach(k => {
        const dh = Math.abs(hexToHsl(t[k]).h - h0);
        expect(Math.min(dh, 360 - dh), `${t.name}.${k} 色相偏了 ${dh.toFixed(1)}°`).toBeLessThan(1.5);
      });
    });
  });

  it('accentSoft 是浅底：与深色正文文字（--ink）对比度足够', () => {
    HERO_THEMES.forEach(t => {
      const ink = '#0f1729';
      const ratio = (Math.max(luminance(t.accentSoft), luminance(ink)) + 0.05) /
                    (Math.min(luminance(t.accentSoft), luminance(ink)) + 0.05);
      expect(ratio, `${t.name} accentSoft ${t.accentSoft}`).toBeGreaterThanOrEqual(7);
    });
  });

  it('默认主题在表内', () => {
    expect(HERO_THEMES.some(t => t.key === DEFAULT_THEME)).toBe(true);
  });

  it('未知 key 回退默认主题（调用方永远拿得到可用色值）', () => {
    expect(getTheme('nope').key).toBe(DEFAULT_THEME);
    expect(getTheme(undefined).key).toBe(DEFAULT_THEME);
  });

  it('themeVars 输出 9 个 CSS 变量（顶栏 3 + 品牌强调色 6）', () => {
    expect(Object.keys(themeVars(getTheme('teal'))).sort()).toEqual([
      '--accent', '--accent-ink', '--accent-line', '--accent-ring', '--accent-soft', '--accent-strong',
      '--hero', '--hero-deep', '--hero-soft'
    ]);
  });

  it('isValidTheme 能区分合法与非法 key', () => {
    expect(isValidTheme('cyan')).toBe(true);
    expect(isValidTheme('rainbow')).toBe(false);
    expect(isValidTheme(null)).toBe(false);
  });
});

describe('theme: 应用与持久化', () => {
  let store;
  beforeEach(() => {
    store = {};
    globalThis.localStorage = {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    };
  });
  afterEach(() => { delete globalThis.localStorage; });

  it('applyTheme 写变量、dataset 与 theme-color，但不落盘', () => {
    const doc = fakeDoc();
    applyTheme(doc, 'rose');
    const t = getTheme('rose');
    expect(doc._vars['--hero']).toBe(t.hero);
    expect(doc._vars['--hero-deep']).toBe(t.heroDeep);
    expect(doc._vars['--hero-soft']).toBe(t.heroSoft);
    // 品牌强调色六件套都要落到 CSS 变量上，否则按钮/选中态不会跟着换
    expect(doc._vars['--accent']).toBe(t.accent);
    expect(doc._vars['--accent-strong']).toBe(t.accentStrong);
    expect(doc._vars['--accent-soft']).toBe(t.accentSoft);
    expect(doc._vars['--accent-line']).toBe(t.accentLine);
    expect(doc._vars['--accent-ink']).toBe(t.accentInk);
    expect(doc._vars['--accent-ring']).toBe(t.accentRing);
    expect(doc.documentElement.dataset.heroTheme).toBe('rose');
    expect(doc._meta.attrs.content).toBe(t.hero);
    expect(store).toEqual({});
  });

  it('saveTheme 应用并记住选择，restoreTheme 能读回来', () => {
    saveTheme(fakeDoc(), 'violet');
    expect(readStoredTheme()).toBe('violet');
    const doc2 = fakeDoc();
    restoreTheme(doc2);
    expect(doc2._vars['--hero']).toBe(getTheme('violet').hero);
  });

  it('存储里是非法值时回退默认，不抛错', () => {
    store['sched.heroTheme'] = 'rainbow';
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });

  it('localStorage 不可用（隐私模式 / file://）时静默降级，仍能应用', () => {
    delete globalThis.localStorage;
    expect(() => saveTheme(fakeDoc(), 'orange')).not.toThrow();
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });
});

describe('theme: 入口挂载', () => {
  const html = buildShellHTML();

  it('桌面工具栏与移动端「更多」弹层各有一个入口', () => {
    expect(html).toContain('id="btnTheme"');
    expect(html).toContain('data-act="theme"');
  });

  it('配色弹层含色卡容器、恢复默认与完成', () => {
    expect(html).toContain('id="themeModal"');
    expect(html).toContain('id="themeGrid"');
    expect(html).toContain('id="btnThemeReset"');
    expect(html).toContain('id="btnThemeDone"');
    expect(html).toContain('id="themeMask"');
  });
});
