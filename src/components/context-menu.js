// ============================================================
// src/components/context-menu.js — 右击快捷选项卡（上下文菜单）
// 需求「右击位置即新建任务开始日」新增：
//   纯函数 dateAtClientX：右击像素坐标 → 对应日期（含时间轴外与越界钳制）
//   菜单项「新增任务」带日期后缀（flags.atDate），右击在哪天就提示从哪天开始
// 需求「右击快捷选项卡」新增：
//   纯函数菜单项构建（可单测）：buildTaskMenuItems / buildModuleMenuItems / buildResMenuItems
//   里程碑=不同类型的任务，右击菜单与任务完全一致（复用 buildTaskMenuItems）
//   DOM 菜单工厂：openContextMenu / closeContextMenu（定位 + 视口钳制 + 外点/Esc/滚动关闭）
// 依赖注入：doc 经参数传入，不读 window 全局；动作经 onPick(key) 回调交由调用方分发，
// 本文件不接触 sched/planStore，保持纯渲染与可测试性。
// ============================================================

import { fmtD } from '../core/dates.js';

// 日期归一化：兼容 Date 与 'YYYY-MM-DD'（core/dates.js 的 F() 仅接受字符串）
function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const p = String(v).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

// ---- 纯函数：右击坐标 → 日期（「右击在哪个位置，新建任务就从哪天开始」）----
// 横轴换算与视图渲染一致：track 左边界 = 项目起始日，每天占 dayW 像素（bars 的 left = X(F(s))）。
// opts: { clientX, trackLeft, ctx }，ctx 需含 { dayW, state: { start, end } }
// 返回：Date（本地 00:00）；落点在时间轴左侧（如左侧固定列）或 ctx 不完整时返回 null
export function dateAtClientX({ clientX, trackLeft, ctx }) {
  if (!ctx || !ctx.state) return null;
  const dayW = ctx.dayW;
  if (!dayW || dayW <= 0) return null;
  const start = asDate(ctx.state.start);
  if (!start || isNaN(start.getTime())) return null;
  if (typeof clientX !== 'number' || typeof trackLeft !== 'number') return null;
  const idxRaw = Math.floor((clientX - trackLeft) / dayW);
  if (!isFinite(idxRaw)) return null;
  if (idxRaw < 0) return null;                 // 未落在时间轴上（左侧固定列等）
  const end = asDate(ctx.state.end);
  let idx = idxRaw;
  if (end && !isNaN(end.getTime())) {
    const maxIdx = Math.round((end - start) / 864e5);
    if (maxIdx >= 0 && idx > maxIdx) idx = maxIdx;   // 越界钳制到项目结束日
  }
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + idx);
}

// ---- 纯函数：菜单项构建 ----
// 返回项描述数组：{ key, label, icon?, danger?, disabled?, divider? }
// flags: { editable, collapsed, atDate } —— 只读时禁用变更类项；collapsed 决定需求折叠文案；
//   atDate（Date|'YYYY-MM-DD'）为右击位置对应日期，存在时「新增任务」带日期后缀（如「新增任务（3/16 起）」）
const addTaskLabel = flags => flags.atDate
  ? `新增任务（${fmtD(asDate(flags.atDate))} 起）`
  : '新增任务';

// 任务（阶段）泳道菜单：新增任务/新建需求 / 编辑 / 标记完成(重置) / 切换计划模式 / 删除
export function buildTaskMenuItems(t, flags = {}) {
  const editable = flags.editable !== false;
  const done = (t && t.done) || 0;
  return [
    { key: 'addTask', label: addTaskLabel(flags), icon: '＋', disabled: !editable },
    { key: 'addModule', label: '新建需求', icon: '▣', disabled: !editable },
    { divider: true },
    { key: 'edit', label: '编辑任务', icon: '✎' },
    { key: 'complete', label: done >= 100 ? '重置进度为 0%' : '标记完成（100%）', icon: '✓', disabled: !editable },
    { key: 'toggleManual', label: t && t.manual ? '切换为自动计划' : '切换为手动计划', icon: '⟳', disabled: !editable },
    { divider: true },
    { key: 'delete', label: '删除任务', icon: '✕', danger: true, disabled: !editable }
  ];
}

// 资源泳道（工作组规划器）菜单：新增任务 / 新建需求 / 管理资源库
export function buildResMenuItems(flags = {}) {
  const editable = flags.editable !== false;
  return [
    { key: 'addTask', label: addTaskLabel(flags), icon: '＋', disabled: !editable },
    { key: 'addModule', label: '新建需求', icon: '▣', disabled: !editable },
    { divider: true },
    { key: 'reslib', label: '管理资源库', icon: '☰' }
  ];
}

// 需求泳道菜单：新增任务(本需求)/新建需求 / 编辑需求 / 折叠(展开) / 归档需求 / 删除需求
export function buildModuleMenuItems(mo, flags = {}) {
  const editable = flags.editable !== false;
  const collapsed = !!flags.collapsed;
  return [
    { key: 'addTask', label: addTaskLabel(flags), icon: '＋', disabled: !editable },
    { key: 'addModule', label: '新建需求', icon: '▣', disabled: !editable },
    { divider: true },
    { key: 'editMod', label: '编辑需求', icon: '⚙' },
    { key: 'toggleCollapse', label: collapsed ? '展开需求' : '折叠需求', icon: collapsed ? '▼' : '▲' },
    { key: 'archiveMod', label: '归档需求', icon: '🗄', disabled: !editable },
    { divider: true },
    { key: 'deleteMod', label: '删除需求', icon: '✕', danger: true, disabled: !editable }
  ];
}

// ---- DOM 菜单工厂（单例：同一时刻仅一个菜单） ----
let activeMenu = null;      // 当前打开的菜单元素
let cleanupFns = [];        // 关闭时需解绑的全局监听

export function closeContextMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  cleanupFns.forEach(fn => { try { fn(); } catch (e) {} });
  cleanupFns = [];
}

// opts: { x, y, items, doc, onPick }
// items 为 buildXxxMenuItems 的返回值；onPick(key) 由调用方分发动作
export function openContextMenu({ x, y, items, doc, onPick }) {
  closeContextMenu();
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || !items || !items.length) return;

  const el = root.createElement('div');
  el.className = 'ctx-menu';
  items.forEach(it => {
    if (it.divider) {
      const hr = root.createElement('div');
      hr.className = 'ctx-divider';
      el.appendChild(hr);
      return;
    }
    const btn = root.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    btn.innerHTML = (it.icon ? '<span class="ctx-ico">' + it.icon + '</span>' : '') +
      '<span class="ctx-label">' + it.label + '</span>';
    if (!it.disabled) {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const key = it.key;
        closeContextMenu();
        if (onPick) onPick(key);
      });
    }
    el.appendChild(btn);
  });
  root.body.appendChild(el);

  // 定位 + 视口钳制（先渲染量尺寸，再收敛到可视区域内，避免溢出屏幕）
  // 注意：.ctx-menu 默认 display:none，此时量得的 rect 全为 0，钳制会失效（屏幕底部/右侧被遮挡）。
  // 故先加 .show 参与布局并置 visibility:hidden 防闪烁，量完尺寸落位后再恢复可见。
  el.style.visibility = 'hidden';
  el.classList.add('show');
  const win = root.defaultView;
  const vw = win ? win.innerWidth : 1024;
  const vh = win ? win.innerHeight : 768;
  const rect = el.getBoundingClientRect();
  let left = x, top = y;
  if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
  if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.visibility = '';
  activeMenu = el;

  // 关闭触发：菜单外按下 / Esc / 甘特滚动（位置失效即收起）
  const onDocDown = ev => { if (!el.contains(ev.target)) closeContextMenu(); };
  const onKey = ev => { if (ev.key === 'Escape') closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  root.addEventListener('mousedown', onDocDown, true);
  root.addEventListener('keydown', onKey);
  const scroller = root.querySelector('.gscroll');
  if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
  cleanupFns.push(() => {
    root.removeEventListener('mousedown', onDocDown, true);
    root.removeEventListener('keydown', onKey);
    if (scroller) scroller.removeEventListener('scroll', onScroll);
  });
}
