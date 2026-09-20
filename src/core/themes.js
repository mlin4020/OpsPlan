// ============================================================
// src/core/themes.js — 主题表 + 色阶派生
//
// 一套主题只需要给「一个主色」`c`，其余 8 个色阶全部按 HSL 自动派生，
// 这样 10 套主题的深浅关系天然一致，加主题也只加一行、不会漏配某个状态。
//
// 派生出的语义色（都会写成 CSS 变量，见 themeVars）：
//   hero          顶栏主色        桌面端渐变亮端 / 移动端纯色底
//   heroDeep      同色系最深色    桌面端渐变暗端 / 移动端顶栏下描边
//   heroSoft      同色系浅色      顶栏上的副标题与统计标签
//   accent        品牌强调色      主按钮、选中态、链接、focus —— 替代原来的 --blue
//   accentStrong  accent 深一档   按钮 hover / active
//   accentSoft    极浅底          选中行的背景、浅色标签底
//   accentLine    浅色描边        选中卡片边框、浅色标签边框
//   accentInk     accent 深色版   浅底上的强调文字（保证对比度）
//   accentRing    半透明光圈      focus 外发光
//
// 约束（tests/theme.test.js 用断言守住）：
//   1) hero 上白字对比度 ≥ 4.5:1；2) heroDeep 必须比 hero 深。
//   状态色（完成绿 / 逾期红 / 卡点琥珀）是数据语义，不属于主题，永远不跟着变。
// ============================================================

export const DEFAULT_THEME = 'cyan';

// 主色清单。顺序即色卡展示顺序（前两个是青系，也是默认推荐）。
export const THEME_SOURCES = [
  { key: 'cyan',     name: '深青',   c: '#0e7490' },
  { key: 'teal',     name: '青绿',   c: '#0f766e' },
  { key: 'emerald',  name: '墨绿',   c: '#047857' },
  { key: 'graphite', name: '石墨灰', c: '#334155' },
  { key: 'violet',   name: '紫罗兰', c: '#7c3aed' },
  { key: 'fuchsia',  name: '品红',   c: '#a21caf' },
  { key: 'rose',     name: '玫红',   c: '#be123c' },
  // 暖橙取 orange-700 而非更亮的 orange-600 (#EA580C)：后者白字对比度仅 3.56:1 不达标
  { key: 'orange',   name: '暖橙',   c: '#c2410c' },
  { key: 'amber',    name: '琥珀',   c: '#b45309' },
  { key: 'brown',    name: '赭棕',   c: '#9a3412' }
];

// ---------- 颜色工具 ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const toHex = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
const rgbToHex = ({ r, g, b }) => '#' + toHex(r) + toHex(g) + toHex(b);

// RGB ↔ HSL（h: 0-360, s/l: 0-100）
export function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }) {
  const S = clamp(s, 0, 100) / 100, L = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = L - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hp) % 6];
  return { r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255 };
}

export const hexToHsl = hex => rgbToHsl(hexToRgb(hex));
export const hslToHex = ({ h, s, l }) => rgbToHex(hslToRgb({ h, s, l }));

// ---------- 从主色派生整套色阶 ----------
// 每个偏移量都只改 HSL 的 L（明度），色相与饱和度保持 —— 这是「同色系」的关键：
// 一旦去动色相，10 套主题就会出现各自不同的偏色，看起来像拼凑的。
export function deriveTheme(src) {
  const { h, s } = hexToHsl(src.c);
  // 饱和度下限：石墨灰这种低饱和主色也要有可辨识的浅底，否则 accentSoft 会趋近纯灰
  const sSoft = clamp(s, 14, 62);
  const at = l => hslToHex({ h, s, l });
  const softAt = l => hslToHex({ h, s: sSoft, l });

  const base = hexToHsl(src.c);
  const rgb = hexToRgb(src.c);

  return {
    key: src.key,
    name: src.name,
    c: src.c,
    hero: src.c,                                   // 主色本身：白字对比度由色表保证
    // 深端用「按比例压暗」而非「固定减多少」：亮主色（紫 L≈58）减固定值会不够深，
    // 暗主色（石墨 L≈27）又会直接压成纯黑，渐变就没了层次
    heroDeep: at(clamp(base.l * 0.45, 8, 100)),
    heroSoft: softAt(clamp(base.l + 58, 0, 94)),
    accent: src.c,
    accentStrong: at(clamp(base.l - 8, 12, 100)),
    accentSoft: softAt(95),
    accentLine: softAt(85),
    accentInk: at(clamp(base.l - 12, 14, 100)),
    accentRing: `rgba(${rgb.r},${rgb.g},${rgb.b},.18)`
  };
}

// 派生结果缓存：色卡渲染与列表遍历会反复取，避免重复做 HSL 往返
const CACHE = new Map();
export function themeList() {
  if (!CACHE.size) THEME_SOURCES.forEach(s => CACHE.set(s.key, deriveTheme(s)));
  return THEME_SOURCES.map(s => CACHE.get(s.key));
}

// 取主题（未知 key 回退默认，保证调用方拿到的永远是可用的完整色阶）
export function getTheme(key) {
  themeList();
  return CACHE.get(key) || CACHE.get(DEFAULT_THEME);
}

// 主题 → CSS 变量。挂到 <html>：避免与业务用的 body class（report-view / readonly-mode）耦合，
// 且 html 级变量在 body 之外（滚动条、原生控件）也能读到。
export function themeVars(theme) {
  const t = theme || getTheme(DEFAULT_THEME);
  return {
    '--hero': t.hero,
    '--hero-deep': t.heroDeep,
    '--hero-soft': t.heroSoft,
    '--accent': t.accent,
    '--accent-strong': t.accentStrong,
    '--accent-soft': t.accentSoft,
    '--accent-line': t.accentLine,
    '--accent-ink': t.accentInk,
    '--accent-ring': t.accentRing
  };
}

// key 是否在主题表内（用于校验 localStorage 里存的值，非法值要走回退）
export function isValidTheme(key) {
  return THEME_SOURCES.some(s => s.key === key);
}

// 兼容旧调用点（曾用 hero/deep/soft 三个短名）
export const HERO_THEMES = themeList();
