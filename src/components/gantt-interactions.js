// ============================================================
// src/components/gantt-interactions.js — 甘特容器重绘后的交互绑定
//
// 从 1112 行的 components/drawers.js 拆出。装的是"渲染产物上的事件"这一类逻辑：
//   tip 气泡 / 需求折叠 / 行级拖拽排序 / 任务条与里程碑（拖拽+点击+长按+右击）/ 同需求悬浮联动
// 触发时机固定：每次 gantt.innerHTML 更新后由 components/index.js 的 afterRender 调用一次。
//
// 为什么 tips/拖拽要按行绑定而不是全局委托：行元素本身每次重绘都会被换掉，
// 委托在容器上会让 dataset 取值变得绕（同一 taskId 在需求行/阶段行/折叠行里语义不同），
// 故保持"重绘后按行绑定"的原策略。
//
// 依赖注入（deps）：gantt/render/toast/bindTip/doc/viewState/sched/
//   startBarDrag/startMsDrag（drag.js 注入）/ consumeSuppress（拖拽结束后的抑制标记）
// ============================================================
import { openModContextMenu, openResContextMenu, openTaskContextMenu } from './menu-actions.js';
import { openTaskDrawer } from './task-drawer.js';
import { updateProblemBadge } from './problem-drawer.js';

// 行级拖动排序状态（同一时刻只可能有一个）
let rowDrag = null;
let rowDragActive = false;

function clearRowHints(deps) {
  deps.gantt.querySelectorAll('.drop-hint-before,.drop-hint-after,.dragging')
    .forEach(el => el.classList.remove('drop-hint-before', 'drop-hint-after', 'dragging'));
}

// 行排序手柄：只认左侧固定名称列 `.mname`。
// 整行设 draggable 会让时间轴空白处也被行排序吃掉（行内 mousedown 会 stopPropagation，
// 事件到不了 .gscroll 的空白平移处理），表现为"想左右拖一下，结果任务被挪了行"。
// 与工作组规划器（行本身不可拖、空白处可平移）保持一致。
export function pickDragHandle(el) {
  return (el && el.querySelector) ? el.querySelector('.mname') : null;
}

function setupRowDnD(el, type, deps) {
  const handle = pickDragHandle(el);
  if (!handle) return;
  // 行本身不可拖，只有左侧名称列是手柄；拖拽事件仍由整行承接（手柄在行内，会冒泡上来），
  // 这样拖到空白轨道上也能落位，不用非得对准名称列松手
  el.draggable = false;
  handle.draggable = true;
  handle.addEventListener('mousedown', e => { if (e.button === 0) e.stopPropagation(); });
  el.addEventListener('dragstart', e => {
    const id = type === 'mod' ? el.dataset.mod : el.dataset.taskId;
    rowDrag = { type, id, mod: el.dataset.mod };
    rowDragActive = true;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); } catch (err) {}
    el.classList.add('dragging');
  });
  el.addEventListener('dragover', e => {
    if (!rowDrag || rowDrag.type !== type) return;
    if (type === 'bar' && rowDrag.mod !== el.dataset.mod) return;
    const targetId = type === 'mod' ? el.dataset.mod : el.dataset.taskId;
    if (rowDrag.id === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    clearRowHints(deps);
    el.classList.add(before ? 'drop-hint-before' : 'drop-hint-after');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    if (!rowDrag || rowDrag.type !== type) return;
    if (type === 'bar' && rowDrag.mod !== el.dataset.mod) { deps.toast('任务阶段仅可在所属需求内排序'); return; }
    const targetId = type === 'mod' ? el.dataset.mod : el.dataset.taskId;
    if (rowDrag.id === targetId) return;
    const r = el.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    if (type === 'mod') deps.sched.moveModule(rowDrag.id, targetId, before);
    else deps.sched.moveBar(rowDrag.id, targetId, before);
    rowDrag = null;
    deps.render();
    deps.toast('已调整' + (type === 'mod' ? '需求' : '任务阶段') + '顺序');
  });
  el.addEventListener('dragend', () => {
    rowDrag = null;
    clearRowHints(deps);
    setTimeout(() => { rowDragActive = false; }, 100);
  });
}

// 绑定单个 bar 或 mile 的事件（详情 + 拖拽 + 移动端长按）
function bindTaskEl(el, isMs, deps) {
  const startDrag = isMs ? deps.startMsDrag : deps.startBarDrag;
  // 归档需求的任务条只读：保留点击查看详情，但不绑定拖拽
  // （工作组规划器现在会置灰展示归档需求的任务，若不拦，拖动会真的改到已收口的排期）
  if (!el.classList.contains('archived')) {
    el.addEventListener('mousedown', e => startDrag(e, el.dataset.taskId, deps));
  }
  const suppress = deps.consumeSuppress || (() => false);
  el.addEventListener('click', e => {
    if (suppress()) return;
    e.stopPropagation();
    openTaskDrawer(el.dataset.taskId, deps);
  });
  // 移动端长按打开详情（500ms 内未滑动判定为长按）
  let lpTimer = null, lpMoved = false, lpX = 0, lpY = 0, lpId = null;
  el.addEventListener('touchstart', e => {
    if (e.touches.length > 1) return;
    const t = e.touches[0];
    lpMoved = false; lpX = t.clientX; lpY = t.clientY; lpId = el.dataset.taskId;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (!lpMoved && lpId) {
        openTaskDrawer(lpId, deps);
        lpId = null;
      }
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (lpId == null) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - lpX) > 10 || Math.abs(t.clientY - lpY) > 10) lpMoved = true;
  }, { passive: true });
  el.addEventListener('touchend', () => { clearTimeout(lpTimer); lpTimer = null; lpId = null; });
  el.addEventListener('touchcancel', () => { clearTimeout(lpTimer); lpTimer = null; lpId = null; });
  // 右击快捷选项卡：阻止默认浏览器菜单，弹出任务/里程碑快捷菜单（里程碑与任务菜单一致）
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    openTaskContextMenu(e, el.dataset.taskId, deps);
  });
}

// ============ 同需求悬浮联动高亮 ============
// 工作组规划器按人分行，同一需求的任务分散在不同人的泳道里，光看条本身难以归组。
// 鼠标停在任一任务条上时，把同需求的条一起描边、其余淡化，归属一眼可辨。
// 事件委托挂在甘特容器上（容器不随 render 重建，无需反复绑定）；
// 仅在「hover 的需求发生变化」时才改 DOM —— mouseover 会在条内子元素
//（btxt / mode-ico / 进度填充）上反复冒泡，不做这层判断等于每次移动都全量重排。
let hoverMod = null;
let hoverBound = false;

// 导出供测试直接验证类切换规则（真实交互依赖 DOM 事件，单测用替身调用本函数）
export function paintModHover(g, mod) {
  if (!g || !g.querySelectorAll) return;
  g.querySelectorAll('.bar[data-mod]').forEach(el => {
    const on = !!mod && el.dataset.mod === mod;
    el.classList.toggle('mod-mate', on);
    el.classList.toggle('mod-dim', !!mod && !on);
  });
}

function applyModHover(g, mod) {
  if (mod === hoverMod) return;   // 同一需求内移动：无 DOM 变更
  hoverMod = mod;
  paintModHover(g, mod);
}

function bindModHoverHighlight(deps) {
  const g = deps.gantt;
  if (!g || hoverBound) return;
  hoverBound = true;
  g.addEventListener('mouseover', e => {
    const el = e.target && e.target.closest ? e.target.closest('.bar[data-mod]') : null;
    applyModHover(g, el ? el.dataset.mod : null);
  });
  // 鼠标移出甘特区：清掉高亮（移进空白轨道时由上面的 mouseover 兜底清除）
  g.addEventListener('mouseleave', () => applyModHover(g, null));
}

// 重绘后绑定甘特内所有交互事件（在 gantt.innerHTML 更新后调用）
export function bindGanttInteractions(deps) {
  const g = deps.gantt;
  if (!g) return;
  // tip
  g.querySelectorAll('.bar,.mile,.fold-bar').forEach(el => {
    deps.bindTip(el, el.dataset.t || el.title, el.dataset.d || '', deps.doc);
  });
  // 需求折叠（拖动排序时不触发折叠）
  g.querySelectorAll('.mod-row').forEach(el => {
    el.addEventListener('click', (e) => {
      // 点击编辑按钮不触发折叠
      if (e.target.closest('.mod-edit-btn')) return;
      if (rowDragActive) return;
      const name = el.dataset.mod;
      deps.viewState.collapsed[name] = !deps.viewState.collapsed[name];
      deps.render();
    });
    // 右击快捷选项卡：需求泳道弹出新增任务/新建需求/编辑/折叠/删除菜单
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 需求行内折叠时的迷你里程碑：右击优先弹出任务菜单（里程碑=任务）
      const mini = e.target && e.target.closest ? e.target.closest('.mile.mini') : null;
      if (mini && mini.dataset.taskId) {
        openTaskContextMenu(e, mini.dataset.taskId, deps);
        return;
      }
      openModContextMenu(e, el.dataset.mod, deps);
    });
  });
  // 阶段泳道右击：整行（含空白 track / 需求·阶段标签）均可弹出任务菜单
  g.querySelectorAll('.bar-row[data-task-id]').forEach(el => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTaskContextMenu(e, el.dataset.taskId, deps);
    });
  });
  // 资源泳道（工作组规划器）右击：整行弹出新增任务/新建需求/资源库菜单
  g.querySelectorAll('.res-row').forEach(el => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openResContextMenu(e, deps);
    });
  });
  // 需求编辑按钮
  g.querySelectorAll('.mod-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const modRow = btn.closest('.mod-row');
      if (!modRow) return;
      const name = modRow.dataset.mod;
      if (deps.modals && deps.modals.openEditModModal) {
        deps.modals.openEditModModal(name);
      }
    });
  });
  // 甘特图底部归档区（只读）：标题行点击展开/收起
  // 展开态放 viewState.archOpen：只影响这一处（独立归档页的卡片展开走 reportExpanded）
  g.querySelectorAll('[data-arch-head]').forEach(el => {
    el.addEventListener('click', () => {
      deps.viewState.archOpen = !deps.viewState.archOpen;
      deps.render();
    });
  });
  // 取消归档（恢复需求到排期视图）：独立归档页的卡片图标 + 甘特图底部归档行的 ↩ 共用
  // 用属性选择器而非类名：两边按钮样式不同，但都产出 data-unarchive，绑在属性上即可通吃
  g.querySelectorAll('[data-unarchive]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.unarchive;
      if (!name || !deps.sched.archiveModule) return;
      if (!confirm(`确认取消归档需求「${name}」？取消后需求将重新出现在排期视图中。`)) return;
      deps.sched.archiveModule(name, false);
      deps.render();
      deps.toast('已取消归档');
    });
  });
  // 行级拖动排序
  g.querySelectorAll('.mod-row').forEach(el => setupRowDnD(el, 'mod', deps));
  g.querySelectorAll('.bar-row[data-task-id]').forEach(el => setupRowDnD(el, 'bar', deps));
  // 任务条
  g.querySelectorAll('.bar[data-task-id]').forEach(el => bindTaskEl(el, false, deps));
  // 里程碑
  g.querySelectorAll('.mile[data-task-id]').forEach(el => bindTaskEl(el, true, deps));
  // 重绘会重建全部任务条（class 全丢），按当前 hover 的需求重涂一次：
  // 否则拖拽结束 / 保存后鼠标没动，高亮却消失了
  paintModHover(g, hoverMod);
  updateProblemBadge(deps);
}

// 一次性绑定（委托在甘特容器上，容器不随重绘更换）
export function bindGanttDelegates(deps) {
  bindModHoverHighlight(deps);
}
