// ============================================================
// src/components/drawer-shell.js — 抽屉外壳：面板状态 + 关闭 + 移动端下拉手势
//
// 从 1112 行的 components/drawers.js 拆出（原先那一个文件同时装着任务抽屉、问题抽屉、
// 右键菜单动作、甘特交互与抽屉手势，改任何一处都得先翻过另外四块）。
//
// 本模块只管"当前打开的是哪个抽屉"这一项**共享状态** —— 任务抽屉与问题抽屉都要读写它，
// 独立出来两者才能互不依赖（放任何一边都会形成循环）。
// 各抽屉模块内部的草稿状态（如任务抽屉的 newTaskMode）用 onDrawerClose 注册回调自行收尾，
// 外壳不感知它们的语义，也就不会反向依赖它们。
// ============================================================

let openPanel = null;    // 'prob' | 'task' | null
const closeHooks = [];   // 关闭时要一并清理的模块内部状态（见 onDrawerClose）

export const getPanel = () => openPanel;
export const setPanel = v => { openPanel = v; };

// 注册"抽屉关闭"时的收尾逻辑。各模块自己管自己的状态，外壳只负责在合适的时机喊一声
export function onDrawerClose(fn) { if (typeof fn === 'function') closeHooks.push(fn); }

export function closeDrawer(deps) {
  openPanel = null;
  closeHooks.forEach(fn => { try { fn(); } catch (e) { /* 收尾失败不应阻断关闭 */ } });
  const pd = deps.getEl('probDrawer'), td = deps.getEl('taskDrawer'), m = deps.getEl('drawerMask');
  if (pd) pd.classList.remove('open');
  if (td) td.classList.remove('open');
  if (m) m.classList.remove('show');
  // 当前打开的任务随之失效（与原先的 setTaskId(deps, null) 等价：未注入 shared 时是空操作）
  if (deps.shared) deps.shared.activeTaskId = null;
}

// ============ 抽屉手势：移动端底部抽屉下拉关闭 ============
// 移动端任务详情/排期问题/需求表单以底部抽屉形态呈现（CSS 负责 translateY(100%) → 0），
// 这里补上「下拉关闭」：拖拽手柄、头部、以及内容区滚到顶部时的继续下拉。
export function bindDrawerSwipe(deps) {
  const win = deps.doc.defaultView;
  const isMobile = () => !!(win && win.matchMedia && win.matchMedia('(max-width: 767px)').matches);
  const THRESHOLD = 76;   // 超过该位移松手即关闭

  ['taskDrawer', 'probDrawer', 'modNewDrawer'].forEach(id => {
    const d = deps.getEl(id);
    if (!d) return;
    const body = d.querySelector('.drawer-body');
    const grips = [d.querySelector('.drawer-grab'), d.querySelector('.drawer-head')].filter(Boolean);
    // 需求抽屉由 modals.js 收口（它还要清 modEditName 编辑态），不能走 closeDrawer
    const close = id === 'modNewDrawer'
      ? () => { if (deps.modals && deps.modals.closeNewModModal) deps.modals.closeNewModModal(); }
      : () => closeDrawer(deps);
    let active = false, dy = 0, y0 = 0, x0 = 0, axis = null;

    const reset = () => {
      active = false; dy = 0; axis = null;
      d.style.transition = 'transform .22s cubic-bezier(.4,0,.2,1)';
      d.style.transform = '';
      setTimeout(() => { if (!active) d.style.transition = ''; }, 240);
    };
    const settle = () => {
      if (dy > THRESHOLD) { active = false; dy = 0; axis = null; d.style.transform = ''; d.style.transition = ''; close(); return; }
      reset();
    };

    const start = (e, fromBody) => {
      if (!isMobile() || e.touches.length !== 1) return;
      if (!fromBody && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
      if (fromBody && body.scrollTop > 0) return;
      const t = e.touches[0];
      y0 = t.clientY; x0 = t.clientX; dy = 0; axis = null; active = true;
      d.style.transition = 'none';
    };
    const move = (e, fromBody) => {
      if (!active) return;
      const t = e.touches[0];
      const ddy = t.clientY - y0, ddx = t.clientX - x0;
      if (axis === null && (Math.abs(ddy) > 8 || Math.abs(ddx) > 8)) {
        axis = (Math.abs(ddy) > Math.abs(ddx) && ddy > 0) ? 'y' : 'x';
      }
      if (axis !== 'y') return;
      if (fromBody && body.scrollTop > 0) { reset(); return; }
      e.preventDefault();               // 仅在确认纵向下拉时阻止页面滚动
      dy = Math.max(0, ddy);
      d.style.transform = `translateY(${dy}px)`;
    };

    grips.forEach(h => {
      h.addEventListener('touchstart', e => start(e, false), { passive: true });
      h.addEventListener('touchmove', e => move(e, false), { passive: false });
      h.addEventListener('touchend', settle);
      h.addEventListener('touchcancel', reset);
    });
    if (body) {
      body.addEventListener('touchstart', e => start(e, true), { passive: true });
      body.addEventListener('touchmove', e => move(e, true), { passive: false });
      body.addEventListener('touchend', settle);
      body.addEventListener('touchcancel', reset);
    }
  });
}

// 装配入口：绑定手势并导出关闭能力
export function bindDrawerShell(deps) {
  bindDrawerSwipe(deps);
  return { closeDrawer: () => closeDrawer(deps) };
}
