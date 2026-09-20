// ============================================================
// src/components/theme-picker.js — 顶栏配色（换肤）选择弹层
//
// 入口有两个，都打开同一个弹层：
//   · 桌面工具栏「数据 → 配色」按钮（#btnTheme）
//   · 移动端「更多」弹层里的「顶栏配色」（由 toolbar.js 以 data-act="theme" 分发过来）
//
// 依赖注入：{ doc, getEl, toast }。主题色值与应用逻辑来自 core/themes.js + utils/theme.js，
// 本模块只负责"渲染色卡 + 点击落盘 + 弹层开合"。
// ============================================================
import { HERO_THEMES, DEFAULT_THEME } from '../core/themes.js';
import { saveTheme, readStoredTheme, restoreTheme } from '../utils/theme.js';

// 渲染色卡网格：色块用「主题渐变」预览，移动端顶栏是纯色、桌面是渐变，
// 这里展示渐变能同时体现两端效果（纯色端就是渐变的亮端）。
function renderGrid(deps) {
  const box = deps.getEl('themeGrid');
  if (!box) return;
  const cur = readStoredTheme();
  box.innerHTML = HERO_THEMES.map(t => `
    <button type="button" class="theme-item${t.key === cur ? ' on' : ''}" data-theme="${t.key}"
      title="${t.name} · ${t.hero}" aria-pressed="${t.key === cur}">
      <span class="theme-sw" style="background:linear-gradient(135deg,${t.heroDeep},${t.hero})"></span>
      <span class="theme-nm">${t.name}</span>
      <span class="theme-ck" aria-hidden="true">✓</span>
    </button>`).join('');

  box.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = saveTheme(deps.doc, btn.dataset.theme);
      // 只改选中态，不重建整个网格（重建会掉焦点，键盘操作会被打断）
      box.querySelectorAll('[data-theme]').forEach(b => {
        const on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      if (deps.toast) deps.toast(`已切换为「${t.name}」`);
    });
  });
}

export function bindThemePicker(deps) {
  const on = (id, fn) => { const el = deps.getEl(id); if (el) el.addEventListener('click', fn); };

  const open = () => {
    renderGrid(deps);
    const m = deps.getEl('themeModal'), k = deps.getEl('themeMask');
    if (m) m.classList.add('show');
    if (k) k.classList.add('show');
  };
  const close = () => {
    const m = deps.getEl('themeModal'), k = deps.getEl('themeMask');
    if (m) m.classList.remove('show');
    if (k) k.classList.remove('show');
  };
  const isOpen = () => {
    const m = deps.getEl('themeModal');
    return !!(m && m.classList.contains('show'));
  };

  on('btnTheme', open);
  on('btnThemeDone', close);
  on('themeMask', close);
  on('btnThemeReset', () => {
    const t = saveTheme(deps.doc, DEFAULT_THEME);
    renderGrid(deps);
    if (deps.toast) deps.toast(`已恢复默认配色「${t.name}」`);
  });

  return {
    open,
    close,
    isOpen,
    // 挂在渲染 ctx 上供 Esc / 入口复用
    restore: () => restoreTheme(deps.doc)
  };
}
