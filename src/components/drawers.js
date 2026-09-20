// ============================================================
// src/components/drawers.js — 任务详情抽屉 + 排期问题抽屉 + 甘特交互事件绑定
// 由 gantt-app.js 迁移：
//   排期问题抽屉（1018-1097）：updateProblemBadge/renderProbList/locateTask/openDrawer/closeDrawer
//   任务详情抽屉（1099-1225）：applyMilestoneView/renderSegType/fillTaskForm/fillMsForm/openTaskDrawer/类型切换
//   资源分配（1227-1241）+ 依赖配置（1418-1494）
//   甘特交互事件（576-661）：tip/折叠/行级 DnD/任务条拖拽+详情/里程碑拖拽+详情
// 依赖注入（deps）：
//   sched/workday/planStore/userStore/render/toast/isReadonly/getEl(按 id 取元素)/gantt/gsc
//   startBarDrag/startMsDrag（来自 drag.js，需注入到 deps 供本文件复用）
//   getCtx：() => 当前渲染 ctx（提供 X/dayW 供 tip 等使用；本文件主要用 render/重绘）
// ============================================================
import { $ } from '../utils/dom.js';
import { milestoneName, isOverdueTask } from '../core/mod-auto.js';
import {
  buildTaskMenuItems, buildModuleMenuItems, buildResMenuItems,
  openContextMenu, dateAtClientX
} from './context-menu.js';

const PROB_ICO = { overlap: '!', depend: '↗', overdue: '⌛', cycle: '∞' };

// 抽屉内部状态（单实例，bindDrawers 一次创建）
// 与 reslib 共享的可变状态（activeTaskId/modalRes）经 deps.shared 注入，避免需求间重复
let draftIsMs = false;          // 当前抽屉选择的类型：true=里程碑
let modalDeps = [];             // 依赖草稿 [{id, lag}]
let openPanel = null;           // 'prob' | 'task' | null
let rowDrag = null;             // 行级拖动排序状态
let rowDragActive = false;
let depMod = null;              // 级联选择的当前需求名（null=未选，渲染时默认取第一个有可用任务的需求）
let newTaskMode = null;         // 新建任务模式：{ mod, start } 或 null（编辑模式；start=右击位置对应日期）
let draftPhase = 'dev';         // 新建模式下的阶段草稿

// 便捷存取共享状态（未注入 shared 时降级为需求内变量）
const curTaskId = deps => (deps.shared ? deps.shared.activeTaskId : null);
const setTaskId = (deps, id) => { if (deps.shared) deps.shared.activeTaskId = id; };
const curModalRes = deps => (deps.shared ? deps.shared.modalRes : modalResShared);
let modalResShared = [];
const setModalRes = (deps, v) => { if (deps.shared) deps.shared.modalRes = v; else modalResShared = v; };

// 只读守卫（组件层统一）：true=可编辑，false=只读
function editable(deps) {
  return !(deps.isReadonly && deps.isReadonly());
}

// ============ 右击快捷选项卡：动作分发 ============
function openAddModModal(deps) {
  if (deps.modals && deps.modals.openNewModModal) deps.modals.openNewModModal();
}

// 右击位置 → 日期：取右击所在泳道的时间轴（.track），按 dayW 换算成对应日期。
// 落在左侧固定列（.mname）或时间轴之外返回 null（调用方回退为今天）。
function dateFromEvent(e, deps) {
  if (!e || typeof e.clientX !== 'number') return null;
  const target = e.target;
  const closest = target && target.closest ? target.closest.bind(target) : null;
  if (closest && closest('.mname')) return null;
  const track = (closest && closest('.track'))
    || (e.currentTarget && e.currentTarget.querySelector ? e.currentTarget.querySelector('.track') : null);
  if (!track || !track.getBoundingClientRect) return null;
  const ctx = deps.getCtx ? deps.getCtx() : null;
  if (!ctx) return null;
  return dateAtClientX({ clientX: e.clientX, trackLeft: track.getBoundingClientRect().left, ctx });
}

// 任务/里程碑泳道菜单动作（里程碑=不同类型的任务，菜单与动作完全一致）：
// addTask/addModule/edit/complete/toggleManual/delete
// atDate：右击位置对应日期，用于新建任务预填开始日（null=回退今天）
function dispatchTaskMenu(key, taskId, deps, atDate) {
  const t = deps.sched.getTask(taskId);
  if (!t) return;
  if (key === 'addTask') {
    openNewTaskDrawer({ mod: t.mod, start: atDate }, deps);
  } else if (key === 'addModule') {
    openAddModModal(deps);
  } else if (key === 'edit') {
    openTaskDrawer(taskId, deps);
  } else if (key === 'complete') {
    const done = (t.done || 0) >= 100 ? 0 : 100;
    // 显式带 type：避免 saveTask 把里程碑误转成普通任务
    deps.sched.saveTask(taskId, { type: t.isMs ? 'ms' : 'task', done });
    deps.render();
    deps.toast(done === 100 ? '已标记完成' : '已重置进度');
  } else if (key === 'toggleManual') {
    deps.sched.saveTask(taskId, { type: t.isMs ? 'ms' : 'task', manual: !t.manual });
    deps.render();
    deps.toast(t.manual ? '已切换为自动计划' : '已切换为手动计划');
  } else if (key === 'delete') {
    const name = deps.sched.nameOf(t);
    if (!confirm(`确认删除${t.isMs ? '里程碑' : '任务'}「${name}」？此操作不可撤销。`)) return;
    deps.sched.deleteTask(taskId);
    deps.render();
    deps.toast(t.isMs ? '已删除里程碑' : '已删除任务');
  }
}

// 需求泳道菜单动作：addTask(本需求)/addModule/editMod/toggleCollapse/deleteMod
function dispatchModMenu(key, modName, deps, atDate) {
  if (key === 'addTask') {
    openNewTaskDrawer({ mod: modName, start: atDate }, deps);
  } else if (key === 'addModule') {
    openAddModModal(deps);
  } else if (key === 'editMod') {
    if (deps.modals && deps.modals.openEditModModal) deps.modals.openEditModModal(modName);
  } else if (key === 'toggleCollapse') {
    deps.viewState.collapsed[modName] = !deps.viewState.collapsed[modName];
    deps.render();
  } else if (key === 'archiveMod') {
    if (!confirm(`确认归档需求「${modName}」？\n归档后需求转为只读，不再显示在排期视图中（可在顶部「归档」页恢复）。`)) return;
    if (!deps.sched.archiveModule) return;
    deps.sched.archiveModule(modName, true);
    delete deps.viewState.collapsed[modName];
    deps.viewState.archOpen = true;   // 归档后展开底部归档区，便于立即看到结果（也可去「归档」页查）
    deps.render();
    deps.toast('已归档需求');
  } else if (key === 'deleteMod') {
    if (!confirm(`确认删除需求「${modName}」及其所有任务？此操作不可撤销。`)) return;
    deps.sched.deleteModule(modName);
    delete deps.viewState.collapsed[modName];
    deps.render();
    deps.toast('已删除需求');
  }
}

// 资源泳道（工作组规划器）菜单动作：addTask/addModule/reslib
function dispatchResMenu(key, deps, atDate) {
  if (key === 'addTask') {
    openNewTaskDrawer({ start: atDate }, deps);
  } else if (key === 'addModule') {
    openAddModModal(deps);
  } else if (key === 'reslib') {
    if (deps.reslib && typeof deps.reslib.openResLib === 'function') deps.reslib.openResLib();
  }
}

// 在指定坐标打开任务/里程碑右击菜单（里程碑与任务菜单一致；只读时禁用变更类项）
function openTaskContextMenu(e, taskId, deps) {
  const t = deps.sched.getTask(taskId);
  if (!t) return;
  const at = dateFromEvent(e, deps);   // 右击位置对应日期（新建任务即从这天开始）
  const items = buildTaskMenuItems(t, { editable: editable(deps), atDate: at });
  openContextMenu({
    x: e.clientX, y: e.clientY, items, doc: deps.doc,
    onPick: key => dispatchTaskMenu(key, taskId, deps, at)
  });
}

// 在指定坐标打开需求行右击菜单
function openModContextMenu(e, modName, deps) {
  const mo = deps.planStore.state.modules.find(m => m.name === modName);
  if (!mo) return;
  const at = dateFromEvent(e, deps);
  const items = buildModuleMenuItems(mo, {
    editable: editable(deps),
    collapsed: !!deps.viewState.collapsed[modName],
    atDate: at
  });
  openContextMenu({
    x: e.clientX, y: e.clientY, items, doc: deps.doc,
    onPick: key => dispatchModMenu(key, modName, deps, at)
  });
}

// 在指定坐标打开资源泳道右击菜单
function openResContextMenu(e, deps) {
  const at = dateFromEvent(e, deps);
  const items = buildResMenuItems({ editable: editable(deps), atDate: at });
  openContextMenu({
    x: e.clientX, y: e.clientY, items, doc: deps.doc,
    onPick: key => dispatchResMenu(key, deps, at)
  });
}

// ============ 抽屉手势：移动端底部抽屉下拉关闭 ============
// 移动端任务详情/排期问题/需求表单以底部抽屉形态呈现（CSS 负责 translateY(100%) → 0），
// 这里补上「下拉关闭」：拖拽手柄、头部、以及内容区滚到顶部时的继续下拉。
function bindDrawerSwipe(deps) {
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

// ============ 排期问题抽屉 ============
function updateProblemBadge(deps) {
  const n = deps.sched.problems().length;
  // 桌面工具栏与移动端操作条各有一个徽标，保持同步
  ['probCount', 'probCountM'].forEach(id => {
    const badge = deps.getEl(id);
    if (!badge) return;
    badge.hidden = n === 0;
    badge.textContent = n;
  });
}

// 归档入口的数量徽标：让"归档里有没有东西"不点进去也能看见。
// 归档是个独立页面，没有徽标的话入口很容易被忽略（这正是它原先埋在页底无人问津的原因）。
function updateArchiveBadge(deps) {
  const modules = (deps.planStore && deps.planStore.state && deps.planStore.state.modules) || [];
  const n = modules.filter(m => !!m.archived).length;
  ['archNavCount', 'archNavCountM'].forEach(id => {
    const badge = deps.getEl(id);
    if (!badge) return;
    badge.hidden = n === 0;
    badge.textContent = n;
  });
}

function locateTask(taskId, on, deps) {
  const el = deps.gantt ? deps.gantt.querySelector(`.bar[data-task-id="${taskId}"]`) : null;
  if (!el) return;
  if (on) {
    el.classList.add('locate');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } else {
    setTimeout(() => el.classList.remove('locate'), 120);
  }
}

function renderProbList(deps) {
  const list = deps.getEl('probList');
  const countEl = deps.getEl('probDrawerCount');
  if (!list) return;
  const problems = deps.sched.problems();
  if (countEl) countEl.textContent = problems.length;
  if (!problems.length) {
    list.innerHTML = '<div class="empty-tip">当前没有排期问题<br>拖拽任务条 / 修改依赖 / 切换手动计划后会自动检测</div>';
    return;
  }
  list.innerHTML = problems.map(p => {
    const t = deps.sched.getTask(p.taskId);
    return `<div class="prob" data-task="${p.taskId}">
      <div class="prob-top"><span class="ico ${p.type}">${PROB_ICO[p.type] || '!'}</span>
        <span class="prob-name">${t ? deps.sched.nameOf(t) : '未知任务'}</span></div>
      <div class="prob-desc">${p.desc}</div>
      <div class="prob-actions">
        <button class="btn primary" data-act="auto" title="自动调整至依赖与资源可用时间">自动调整</button>
        <button class="btn ghost" data-act="ignore" title="保留现状并忽略此问题">忽略</button>
      </div></div>`;
  }).join('');
  list.querySelectorAll('.prob').forEach(item => {
    const taskId = item.dataset.task;
    item.addEventListener('mouseenter', () => locateTask(taskId, true, deps));
    item.addEventListener('mouseleave', () => locateTask(taskId, false, deps));
    item.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'auto') { deps.sched.resolveAuto(taskId); deps.toast('已自动调整排期'); }
        else { deps.sched.resolveIgnore(taskId); deps.toast('已忽略该问题'); }
        renderProbList(deps);
        updateProblemBadge(deps);
        deps.render();
      });
    });
    item.addEventListener('click', () => locateTask(taskId, true, deps));
  });
}

function openProblemDrawer(deps) {
  openPanel = 'prob';
  const d = deps.getEl('probDrawer'), m = deps.getEl('drawerMask');
  if (d) d.classList.add('open');
  if (m) m.classList.add('show');
  renderProbList(deps);
}

function closeDrawer(deps) {
  openPanel = null;
  newTaskMode = null;   // 关闭抽屉即退出新建模式
  const pd = deps.getEl('probDrawer'), td = deps.getEl('taskDrawer'), m = deps.getEl('drawerMask');
  if (pd) pd.classList.remove('open');
  if (td) td.classList.remove('open');
  if (m) m.classList.remove('show');
  setTaskId(deps, null);
}

// ============ 任务详情抽屉 ============
function applyMilestoneView(on, deps) {
  const disp = on ? 'none' : '';
  ['rowRes', 'rowDur', 'rowProgress'].forEach(id => { const el = deps.getEl(id); if (el) el.style.display = disp; });
  ['dateSep', 'inpEnd', 'inpW', 'lblWork'].forEach(id => { const el = deps.getEl(id); if (el) el.style.display = disp; });
  // 里程碑名称提示：留空时只能回退到阶段名，图上会退化成一个没信息量的名字，
  // 故切换类型时同步改字段标题与占位示例，引导用户填写业务卡点名
  const nmLabel = deps.getEl('lblName');
  const inpName = deps.getEl('inpName');
  if (nmLabel) nmLabel.textContent = on ? '里程碑名称' : '任务名称';
  if (inpName) inpName.placeholder = on
    ? '如：需求评审 / 提测 / 上线（留空按阶段名显示）'
    : '留空按「需求 · 阶段」显示';
}

function renderSegType(ms, deps) {
  const box = deps.getEl('segType');
  if (!box) return;
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.ms === 'true') === ms));
}

function renderSeg(manual, deps) {
  const box = deps.getEl('segManual');
  if (!box) return;
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.manual === 'true') === manual));
}

// 普通任务表单：字段 + 问题提示统一填充（抽屉打开 / 类型切换共用）
function fillTaskForm(t, deps) {
  const _span = t.s && t.e ? deps.workday.spanDays(t.s, t.e) : 1;
  const _work = deps.workday.workDays(t.s || t.m, t.e || t.s || t.m);
  const g = deps.getEl;
  g('taskTitle').textContent = deps.sched.nameOf(t);
  g('taskSub').textContent = `${t.mod} · 进度 ${t.done || 0}% · 工作量 ${_work}人天 · 时间 ${t.s || t.m} ~ ${t.e || t.s || t.m}`;
  g('inpName').value = t.name || '';
  modalDeps = (t.dep || []).map(d => ({ ...d }));
  setModalRes(deps, [...(t.res || [])]);
  renderSeg(t.manual, deps);
  renderResPicker(deps);
  renderDepList(deps);
  renderDepSelect(deps);
  g('inpStart').value = t.s || t.m || '';
  g('inpEnd').value = t.e || t.s || t.m || '';
  g('inpW').value = t.w != null ? t.w : _work;   // 默认展示工作量（人天）
  g('lblWork').textContent = _work + ' 人天';
  g('inpStart').disabled = !t.manual;
  const un = g('btnUnignore'); if (un) un.hidden = !t.ignore;
  const pct = t.done || 0;
  g('inpProgress').value = pct;
  g('lblProgress').textContent = pct + '%';
  const probs = deps.sched.problems().filter(p => p.taskId === t.id);
  const isOverdue = isOverdueTask(t, deps.today());
  const fIssue = g('fIssue');
  const ro = deps.isReadonly();
  const taskId = t.id;

  if (probs.length || isOverdue) {
    fIssue.hidden = false;
    let html = '<div class="issue-note"><b>⚠ 存在排期问题：</b></div>';
    // 每个排期问题独立条目（含处理按钮）
    const allIssues = [
      ...probs.map(p => ({ desc: p.desc, taskId: p.taskId })),
      ...(isOverdue ? [{ desc: `⚠ 任务已逾期！结束日期 ${t.e} 已过，当前进度 ${pct}%`, taskId: t.id }] : [])
    ];
    allIssues.forEach(item => {
      html += `<div class="issue-item">
        <div class="issue-item-desc">${item.desc}</div>
        <div class="issue-item-actions">
          ${ro ? '' : `<button class="btn primary iss-auto" data-task-id="${item.taskId}">自动调整</button>
          <button class="btn ghost iss-ignore" data-task-id="${item.taskId}">忽略</button>`}
        </div>
      </div>`;
    });
    fIssue.innerHTML = html;
  } else {
    fIssue.hidden = true;
  }
  g('taskHint').textContent = t.manual
    ? '手动计划：日期被锁定，与依赖/资源冲突时将在排期问题中标记'
    : '自动计划任务由依赖与资源自动计算日期';
}

// 里程碑表单：0 天周期单点，支持 自动(依赖驱动上线日) / 手动(指定日期)
function fillMsForm(t, deps) {
  const g = deps.getEl;
  const fIssue = g('fIssue'); if (fIssue) fIssue.hidden = true;
  const un = g('btnUnignore'); if (un) un.hidden = true;
  const rd = g('rowDeps'); if (rd) rd.style.display = '';   // 确保前置依赖（含添加控件）可见
  g('taskTitle').textContent = milestoneName(t, t.mod);
  g('taskSub').textContent = `${t.mod} · 上线日期 ${t.m || t.s}`;
  g('inpName').value = t.label || '';
  const msManual = t.manual !== false;
  renderSeg(msManual, deps);
  modalDeps = (t.dep || []).map(d => ({ ...d }));
  renderDepList(deps);
  renderDepSelect(deps);
  g('inpStart').value = t.m || t.s || '';
  g('inpStart').disabled = !msManual;
  g('taskHint').textContent = msManual
    ? '里程碑（0 天周期，代表某个时间点）：手动模式可指定上线日期，或拖拽菱形标记调整'
    : '里程碑（0 天周期，代表某个时间点）：自动模式由前置依赖自动计算上线日期，可拖拽菱形标记锁定';
}

// 新建/编辑共用抽屉：需求+阶段下拉渲染（两种模式均可见，编辑模式可改归属）
// preset: { mod, phase } 编辑模式传入任务当前的需求/阶段；新建模式缺省回退 newTaskMode.mod + draftPhase
function renderModPhaseSelects(deps, preset) {
  const g = deps.getEl;
  const modSel = g('inpMod'), phSel = g('inpPhase');
  if (!modSel || !phSel) return;
  // 已归档需求不可作为任务归属（只读收口），仅列出在排需求
  modSel.innerHTML = deps.planStore.state.modules.filter(m => !m.archived)
    .map(m => `<option value="${m.name}">${m.name}</option>`).join('');
  phSel.innerHTML = Object.keys(deps.PNAME).map(k => `<option value="${k}">${deps.PNAME[k]}</option>`).join('');
  const pre = (preset && preset.mod) || (newTaskMode && newTaskMode.mod);
  if (pre && [...modSel.options].some(o => o.value === pre)) modSel.value = pre;
  const prePhase = (preset && preset.phase) || draftPhase;
  phSel.value = Object.keys(deps.PNAME).includes(prePhase) ? prePhase : (deps.PNAME.dev ? 'dev' : phSel.value);
  // 只读：下拉禁用（保存本身由 saveTask 守卫，此处仅避免误导可改）
  const ro = !editable(deps);
  modSel.disabled = ro;
  phSel.disabled = ro;
}

// 新建模式表单默认值（与编辑同一表单）
// 开始日期：newTaskMode.start 存在时取右击位置对应日期，否则取今天
function fillNewTaskForm(deps) {
  const g = deps.getEl;
  const start = (newTaskMode && newTaskMode.start)
    ? deps.sched.fmt(newTaskMode.start)
    : deps.sched.fmt(deps.today());
  g('taskTitle').textContent = '新增任务';
  g('taskSub').textContent = '与编辑任务共用同一表单';
  g('inpName').value = '';
  modalDeps = [];
  setModalRes(deps, []);
  renderSeg(true, deps);
  renderResPicker(deps);
  renderDepList(deps);
  renderDepSelect(deps);
  g('inpStart').value = start;
  g('inpStart').disabled = false;
  g('inpEnd').value = start;
  g('inpW').value = 1;
  g('lblWork').textContent = '1 人天';
  const un = g('btnUnignore'); if (un) un.hidden = true;
  g('inpProgress').value = 0;
  g('lblProgress').textContent = '0%';
  const fIssue = g('fIssue'); if (fIssue) fIssue.hidden = true;
  g('taskHint').textContent = (newTaskMode && newTaskMode.start)
    ? `新建任务：开始日期已按右击位置预填为 ${start}（可修改）；选择需求/阶段/类型/资源后保存`
    : '新建任务：选择需求/阶段/类型/日期/资源后保存';
}

// 打开任务抽屉：编辑模式（newTaskMode=null；需求/阶段行可见，可改归属）
function openTaskDrawer(taskId, deps) {
  const t = deps.sched.getTask(taskId);
  if (!t) return;
  newTaskMode = null;
  const row = deps.getEl('rowModPhase'); if (row) row.hidden = false;
  setTaskId(deps, taskId);
  draftIsMs = !!t.m;
  renderSegType(draftIsMs, deps);
  applyMilestoneView(draftIsMs, deps);
  renderModPhaseSelects(deps, { mod: t.mod, phase: t.p });
  if (draftIsMs) fillMsForm(t, deps); else fillTaskForm(t, deps);
  const del = deps.getEl('btnDeleteTask'); if (del) del.style.display = '';
  openPanel = 'task';
  const d = deps.getEl('taskDrawer'), m = deps.getEl('drawerMask');
  if (d) d.classList.add('open');
  if (m) m.classList.add('show');
}

// 打开任务抽屉：新建模式（opts={mod,start}：预选需求 + 右击位置对应的开始日期；
// 显示需求/阶段行，隐藏删除按钮）
function openNewTaskDrawer(opts, deps) {
  newTaskMode = { mod: (opts && opts.mod) || '', start: (opts && opts.start) || null };
  draftPhase = deps.PNAME.dev ? 'dev' : draftPhase;
  const row = deps.getEl('rowModPhase'); if (row) row.hidden = false;
  setTaskId(deps, null);
  draftIsMs = false;
  renderSegType(false, deps);
  applyMilestoneView(false, deps);
  renderModPhaseSelects(deps);
  fillNewTaskForm(deps);
  const del = deps.getEl('btnDeleteTask'); if (del) del.style.display = 'none';
  openPanel = 'task';
  const d = deps.getEl('taskDrawer'), m = deps.getEl('drawerMask');
  if (d) d.classList.add('open');
  if (m) m.classList.add('show');
}

// ============ 资源分配 + 依赖配置 ============
function renderResPicker(deps) {
  const box = deps.getEl('resPicker');
  if (!box) return;
  const mr = curModalRes(deps);
  box.innerHTML = (deps.planStore.state.resources || []).map(r => {
    const sel = mr.includes(r.name) ? ' sel' : '';
    return `<div class="res-pick${sel}" data-res="${r.name}">
      <span class="avatar" style="background:${r.color}">${r.name[0]}</span>${r.name}<span style="color:#94a3b8;font-size:10px">${r.role}</span></div>`;
  }).join('');
  box.querySelectorAll('.res-pick').forEach(el => el.addEventListener('click', () => {
    const name = el.dataset.res;
    const arr = curModalRes(deps);
    const i = arr.indexOf(name);
    if (i >= 0) arr.splice(i, 1); else arr.push(name);
    el.classList.toggle('sel', curModalRes(deps).includes(name));
  }));
}

function depName(d, deps) {
  const t = deps.sched.getTask(d.id);
  return t ? `[${t.mod}] ${deps.sched.nameOf(t)}` : ('#' + d.id);
}

function renderDepList(deps) {
  const list = deps.getEl('depList');
  if (!list) return;
  if (!modalDeps.length) {
    list.innerHTML = '<div class="empty-tip" style="padding:10px">暂无前置依赖</div>';
    return;
  }
  list.innerHTML = modalDeps.map((d, i) => `
    <div class="dep-item">
      <span class="steel" style="width:6px;height:6px;border-radius:2px;background:#94a3b8;flex:none"></span>
      <span class="dep-name">${depName(d, deps)}</span>
      <span class="dep-lag">
        <input type="number" class="dep-lag-input" data-i="${i}" value="${d.lag != null ? d.lag : 0}" title="偏移天数：正=前置完成后延后，负=前置完成前即可开始"> 天
      </span>
      <button class="del" data-i="${i}">×</button>
    </div>`).join('');
  list.querySelectorAll('.dep-lag-input').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i;
    modalDeps[i].lag = +inp.value || 0;
  }));
  list.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    modalDeps.splice(+b.dataset.i, 1);
    renderDepList(deps);
    renderDepSelect(deps);
  }));
}

// 级联选择：先选需求（depModSelect），任务下拉（depSelect）仅列出该需求下可作前置的任务；
// 选中任务即自动添加为前置依赖（无需再点「添加」按钮），添加后下拉自动回退到占位项并刷新候选。
function renderDepTaskOptions(sel, list, deps) {
  const s = (list || []).sort((a, b) => (a.s || a.m || '').localeCompare(b.s || b.m || ''));
  sel.innerHTML = s.length
    ? '<option value="">选择任务（选中即添加）…</option>' + s.map(t =>
        `<option value="${t.id}">[${t.mod}] ${deps.sched.nameOf(t)}（${t.isMs ? t.m + ' 上线' : t.e + ' 结束'}）</option>`).join('')
    : '<option value="">该需求暂无可用任务</option>';
  sel.value = '';
  // 选中任务 → 立即添加为前置依赖并刷新候选（避免重复添加）；
  // renderDepSelect 内部会基于已更新的 modalDeps 重新过滤候选，且 depMod 保持当前需求不变
  sel.onchange = () => {
    const id = sel.value;
    if (!id) return;
    const wasMod = depMod;
    modalDeps.push({ id, lag: 0 });
    renderDepList(deps);
    renderDepSelect(deps);
    depMod = wasMod;   // 保持当前需求，仅刷新候选任务
    const ms = deps.getEl('depModSelect');
    if (ms) ms.value = wasMod;
  };
}

function renderDepSelect(deps) {
  const modSel = deps.getEl('depModSelect');
  const sel = deps.getEl('depSelect');
  if (!modSel || !sel) return;
  const taken = new Set(modalDeps.map(d => d.id));
  const tasks = deps.sched.tasks()
    .filter(t => t.id !== curTaskId(deps) && !taken.has(t.id));
  // 按需求分组
  const byMod = new Map();
  tasks.forEach(t => {
    const arr = byMod.get(t.mod) || [];
    arr.push(t);
    byMod.set(t.mod, arr);
  });
  const modNames = [...byMod.keys()].sort((a, b) => a.localeCompare(b));
  modSel.innerHTML = modNames.length
    ? '<option value="">选择需求…</option>' + modNames.map(n => `<option value="${n}">${n}</option>`).join('')
    : '<option value="">无可用需求</option>';
  // 校验当前选中需求：失效则回退到第一个
  const cur = depMod && modNames.includes(depMod) ? depMod : (modNames[0] || '');
  depMod = cur;
  modSel.value = cur;
  // 渲染任务下拉（该需求下可选任务）
  renderDepTaskOptions(sel, byMod.get(cur) || [], deps);
  // 需求切换 → 级联刷新任务下拉
  modSel.onchange = () => {
    depMod = modSel.value || '';
    renderDepTaskOptions(sel, byMod.get(depMod) || [], deps);
  };
}

// ============ 甘特交互事件（每次重绘后调用：tip/折叠/行级DnD/任务条/里程碑） ============
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
function bindGanttInteractions(deps) {
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
  // 归档数量徽标与问题徽标一样按渲染刷新：归档 / 取消归档后立即反映在入口上
  updateArchiveBadge(deps);
}

// ============ 抽屉控件事件绑定（一次性，dom 常驻部分） ============
function bindTaskDrawerControls(deps) {
  const g = deps.getEl;
  const on = (id, fn) => { const el = g(id); if (el) el.addEventListener('click', fn); };
  const onInp = (id, ev, fn) => { const el = g(id); if (el) el.addEventListener(ev, fn); };

  // 类型切换（普通任务 <-> 里程碑）；新建/编辑共用
  const segType = g('segType');
  if (segType) segType.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    draftIsMs = b.dataset.ms === 'true';
    renderSegType(draftIsMs, deps);
    applyMilestoneView(draftIsMs, deps);
    if (newTaskMode) {
      // 新建模式：仅切换字段显隐与提示，日期始终可编辑
      g('inpStart').disabled = false;
      g('taskHint').textContent = draftIsMs
        ? '里程碑（0 天周期，代表某个时间点）：指定上线日期'
        : '普通任务：指定开始日期与持续天数';
      return;
    }
    if (!curTaskId(deps)) return;
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t) return;
    if (draftIsMs) {
      fillMsForm(t, deps);
    } else {
      fillTaskForm(t, deps);
      if (t.m) {
        renderSeg(true, deps);
        g('inpStart').disabled = false;
      }
    }
  }));

  // 计划模式切换（手动/自动）
  const segManual = g('segManual');
  if (segManual) segManual.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    const manual = b.dataset.manual === 'true';
    renderSeg(manual, deps);
    g('inpStart').disabled = !manual;
    g('taskHint').textContent = draftIsMs
      ? (manual
          ? '里程碑（0 天周期，代表某个时间点）：手动模式可指定上线日期，或拖拽菱形标记调整'
          : '里程碑（0 天周期，代表某个时间点）：自动模式由前置依赖自动计算上线日期，可拖拽菱形标记锁定')
      : (manual
          ? '手动计划：日期被锁定，与依赖/资源冲突时将在排期问题中标记'
          : '自动计划任务由依赖与资源自动计算日期');
  }));

  on('btnCloseTaskDrawer', () => closeDrawer(deps));

  // 保存任务（新建/编辑共用同一表单）
  on('btnSaveTask', () => {
    const manualBtn = g('segManual').querySelector('.btn.on');
    const manual = !!manualBtn && manualBtn.dataset.manual === 'true';
    const start = g('inpStart').value;

    // 新建模式：sched.addTask
    if (newTaskMode) {
      const mod = g('inpMod') ? g('inpMod').value : '';
      if (!mod) { deps.toast('请选择需求'); return; }
      if (!start) { deps.toast('请选择' + (draftIsMs ? '上线' : '开始') + '日期'); return; }
      const p = g('inpPhase') ? g('inpPhase').value : 'dev';
      const name = g('inpName').value.trim();
      let newId;
      try {
        if (draftIsMs) {
          newId = deps.sched.addTask({ mod, p, name, type: 'ms', start, manual });
        } else {
          const dur = Math.max(1, +g('inpW').value || 1);
          newId = deps.sched.addTask({ mod, p, name, type: 'task', start, dur, manual, res: [...curModalRes(deps)] });
        }
      } catch (err) { deps.toast(err.message); return; }
      // addTask 不接收 dep：新建后补写前置依赖。
      // 必须显式带 type：否则 saveTask 会把新建的里程碑误判为"转成普通任务"（删除 m 且 res 未初始化）
      if (modalDeps.length) deps.sched.saveTask(newId, { type: draftIsMs ? 'ms' : 'task', dep: modalDeps.map(d => ({ ...d })) });
      newTaskMode = null;
      closeDrawer(deps);
      deps.render();
      deps.toast(draftIsMs ? '已新增里程碑' : '已新增任务');
      return;
    }

    // 编辑模式：sched.saveTask
    if (!curTaskId(deps)) return;
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t) return;
    const mod = g('inpMod') ? g('inpMod').value : '';
    const p = g('inpPhase') ? g('inpPhase').value : '';
    const draft = {
      type: draftIsMs ? 'ms' : 'task',
      name: g('inpName').value.trim(),
      start: start || undefined,
      dur: +g('inpW').value || undefined,
      manual,
      done: draftIsMs ? undefined : Math.min(100, Math.max(0, +g('inpProgress').value || 0)),
      res: draftIsMs ? undefined : [...curModalRes(deps)],
      dep: modalDeps.map(d => ({ ...d })),
      mod,   // 归属变更：改需求（跨需求移动）/ 阶段
      p
    };
    deps.sched.saveTask(curTaskId(deps), draft);
    closeDrawer(deps);
    deps.render();
    const moved = mod && t.mod && mod !== t.mod;
    deps.toast(moved ? `已保存并移动到「${mod}」` : '已保存');
  });

  // 任务抽屉内「管理资源」快捷入口（源 gantt-app.js btnDrawerResLib）
  on('btnDrawerResLib', () => {
    if (deps.reslib && typeof deps.reslib.openResLib === 'function') {
      deps.reslib.openResLib();
    }
  });

  // 撤销忽略
  on('btnUnignore', () => {
    deps.sched.unignore(curTaskId(deps));
    const b = g('btnUnignore'); if (b) b.hidden = true;
    deps.render();
    deps.toast('已取消忽略');
  });

  // 删除任务
  on('btnDeleteTask', () => {
    if (!curTaskId(deps)) return;
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t) return;
    const name = deps.sched.nameOf(t);
    if (!confirm(`确认删除任务「${name}」？此操作不可撤销。`)) return;
    deps.sched.deleteTask(curTaskId(deps));
    closeDrawer(deps);
    deps.render();
    deps.toast('已删除任务');
  });

  // 开始日期变更：联动结束日期与工作量（新建/编辑共用）
  onInp('inpStart', 'change', e => {
    if (draftIsMs) return;
    if (!e.target.value) return;
    if (newTaskMode) {
      const days = Math.max(1, +g('inpW').value || 1);
      const end = deps.workday.addWorkdays(new Date(e.target.value), days);   // 工作量→结束日（处理节假日）
      g('inpEnd').value = deps.sched.fmt(end);
      g('lblWork').textContent = days + ' 人天';
      return;
    }
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t || t.isMs) return;
    const work = Math.max(1, deps.workday.workDays(t.s, t.e) || 1);   // 保留原工作量（人天）
    const end = deps.workday.addWorkdays(new Date(e.target.value), work);   // 工作量→结束日（处理节假日）
    g('inpEnd').value = deps.sched.fmt(end);
    g('lblWork').textContent = work + ' 人天';
    g('inpW').value = work;
  });
  // 工作量（人天）变更：按工作日推算结束日（自动跳过周末/节假日）
  onInp('inpW', 'input', e => {
    if (draftIsMs || !e.target.value) return;
    const days = Math.max(1, +e.target.value || 1);
    const startStr = g('inpStart').value;
    const start = startStr ? new Date(startStr) : (curTaskId(deps) && deps.sched.getTask(curTaskId(deps)) ? deps.sched.F(deps.sched.getTask(curTaskId(deps)).s) : null);
    if (!start) return;
    const end = deps.workday.addWorkdays(start, days);   // 工作量→结束日（处理节假日）
    g('inpEnd').value = deps.sched.fmt(end);
    g('lblWork').textContent = days + ' 人天';
  });
  // 进度滑块同步
  onInp('inpProgress', 'input', e => {
    const v = Math.min(100, Math.max(0, +e.target.value || 0));
    g('lblProgress').textContent = v + '%';
  });
  // 一键完成
  on('btnQuickComplete', () => {
    g('inpProgress').value = 100;
    g('lblProgress').textContent = '100%';
  });

  // 排期问题抽屉开关
  on('btnProblems', () => {
    if (openPanel === 'prob') closeDrawer(deps); else openProblemDrawer(deps);
  });
  on('btnCloseDrawer', () => closeDrawer(deps));
  on('drawerMask', () => closeDrawer(deps));
  on('btnAutoFixAll', () => {
    const ids = [...new Set(deps.sched.problems().map(p => p.taskId))];
    ids.forEach(id => deps.sched.resolveAuto(id));
    deps.toast(`已自动调整 ${ids.length} 项问题`);
    renderProbList(deps);
    updateProblemBadge(deps);
    deps.render();
  });

  // 任务编辑抽屉内问题区域按钮的事件委托（一次性绑定，避免重复监听）
  const fIssue = g('fIssue');
  if (fIssue) {
    fIssue.addEventListener('click', ev => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      ev.stopPropagation();
      const id = btn.dataset.taskId;
      if (!id) return;
      if (btn.classList.contains('iss-auto')) {
        deps.sched.resolveAuto(id);
        deps.toast('已自动调整排期');
      } else if (btn.classList.contains('iss-ignore')) {
        deps.sched.resolveIgnore(id);
        deps.toast('已忽略该问题');
      }
      // 刷新: 重绘甘特 + 更新问题徽标 + 重新填充当前任务表单
      deps.render();
      updateProblemBadge(deps);
      const cur = curTaskId(deps);
      if (cur) {
        const updated = deps.sched.getTask(cur);
        if (updated) fillTaskForm(updated, deps);
      }
    });
  }
}

// 聚合入口：绑定所有抽屉/甘特交互，返回外部可用的抽屉 API
export function bindDrawers(deps) {
  bindTaskDrawerControls(deps);
  bindModHoverHighlight(deps);   // 同需求悬浮联动：委托在甘特容器上，只绑一次
  bindDrawerSwipe(deps);         // 移动端底部抽屉：下拉关闭（桌面/平板不触发）
  return {
    openTaskDrawer: (id) => openTaskDrawer(id, deps),
    openNewTaskDrawer: (opts) => openNewTaskDrawer(opts, deps),
    openProblemDrawer: () => openProblemDrawer(deps),
    closeDrawer: () => closeDrawer(deps),
    updateProblemBadge: () => updateProblemBadge(deps),
    renderProbList: () => renderProbList(deps),
    renderResPicker: () => renderResPicker(deps),
    bindGanttInteractions: () => bindGanttInteractions(deps)
  };
}

// 供 render ctx 注入：打开任务详情抽屉（main-gantt 接线）
export function makeDrawerCtxInject(deps) {
  return {
    openDrawer: (taskId) => openTaskDrawer(taskId, deps),
    closeDrawer: () => closeDrawer(deps)
  };
}
