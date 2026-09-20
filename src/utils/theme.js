// ============================================================
// src/utils/theme.js — 顶栏换肤的读写
//
// 应用方式：把主题色写成 <html> 上的 CSS 变量（见 core/themes.js 的 themeVars）。
// 持久化：localStorage。取不到（隐私模式 / file:// 下的只读查看器）就静默降级为
//          "本次会话有效"，绝不因为存储异常影响页面启动。
// ============================================================
import { HERO_THEMES, DEFAULT_THEME, getTheme, themeVars, isValidTheme } from '../core/themes.js';

const STORE_KEY = 'sched.heroTheme';

function storage() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (e) {
    return null;   // Safari 隐私模式下访问 localStorage 会直接抛错
  }
}

// 读取已保存的主题 key（无存储 / 值非法时返回默认）
export function readStoredTheme() {
  const s = storage();
  if (!s) return DEFAULT_THEME;
  try {
    const k = s.getItem(STORE_KEY);
    return isValidTheme(k) ? k : DEFAULT_THEME;
  } catch (e) {
    return DEFAULT_THEME;
  }
}

// 应用主题到 DOM（不写存储）：返回实际生效的主题对象
export function applyTheme(doc, key) {
  const root = doc && doc.documentElement;
  const t = getTheme(key);
  if (root && root.style && root.style.setProperty) {
    const vars = themeVars(t);
    Object.keys(vars).forEach(k => root.style.setProperty(k, vars[k]));
  }
  if (root && root.dataset) root.dataset.heroTheme = t.key;
  // 移动端浏览器地址栏跟随顶栏色（桌面端无影响）
  const meta = doc && doc.querySelector && doc.querySelector('meta[name="theme-color"]');
  if (meta && meta.setAttribute) meta.setAttribute('content', t.hero);
  return t;
}

// 应用 + 持久化：换肤入口点击时调用
export function saveTheme(doc, key) {
  const t = applyTheme(doc, key);
  const s = storage();
  if (s) { try { s.setItem(STORE_KEY, t.key); } catch (e) { /* 配额满等：忽略，仍已生效 */ } }
  return t;
}

// 启动时恢复：应在渲染前尽早调用，避免首屏闪一下默认色
export function restoreTheme(doc) {
  return applyTheme(doc, readStoredTheme());
}

export { HERO_THEMES, DEFAULT_THEME };
