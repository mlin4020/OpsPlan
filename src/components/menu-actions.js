// ============================================================
// src/components/menu-actions.js — 右键菜单的动作分发
//
// 从 1112 行的 components/drawers.js 拆出。与 context-menu.js 的分工：
//   context-menu.js  负责"菜单长什么样、怎么弹、怎么关"（纯渲染，不碰 sched/planStore）
//   本模块            负责"点了哪一项、要做什么"（会改数据：新建/编辑/删除/归档/折叠）
// 这个边界原本就写在 context-menu.js 的文件头里，拆出来是为了不破坏它。
//
// 三个入口：任务/里程碑泳道、需求行、资源泳道；里程碑=不同类型的任务，菜单与动作完全一致。
// 依赖注入（deps）：sched/planStore/viewState/render/toast/getCtx/doc/modals/reslib
// ============================================================
import { buildTaskMenuItems, buildModuleMenuItems, buildResMenuItems, openContextMenu, dateAtClientX } from './context-menu.js';
import { openNewTaskDrawer, openTaskDrawer } from './task-drawer.js';

// 只读守卫（组件层统一）：true=可编辑，false=只读
function editable(deps) {
  return !(deps.isReadonly && deps.isReadonly());
}

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

// 需求泳道菜单动作：addTask(本需求)/addModule/editMod/toggleCollapse/deleteMod/archiveMod
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
export function openTaskContextMenu(e, taskId, deps) {
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
export function openModContextMenu(e, modName, deps) {
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
export function openResContextMenu(e, deps) {
  const at = dateFromEvent(e, deps);
  const items = buildResMenuItems({ editable: editable(deps), atDate: at });
  openContextMenu({
    x: e.clientX, y: e.clientY, items, doc: deps.doc,
    onPick: key => dispatchResMenu(key, deps, at)
  });
}
