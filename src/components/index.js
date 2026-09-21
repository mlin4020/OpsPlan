// ============================================================
// src/components/index.js — 组件层聚合入口
// 一次性绑定全部组件事件，供 main-gantt（Task 5）在排期页初始化时调用。
// bindAll(deps) 接收完整依赖并完成：
//   1) 归一化公共依赖（doc/getEl/gantt/gsc/toast/bindTip/PNAME/isReadonly/workday/today）
//   2) 创建抽屉/reslib 共享状态（activeTaskId/modalRes）
//   3) 绑定工具栏/抽屉(+拖拽)/弹窗/资源库/同步状态/loading
//   4) 生成 render ctx 注入回调（openDrawer/openModal/onDragStart），供 renderAll 使用
//   5) 返回 API：{ afterRender, ctxInjection, setSync, showLoading, hideLoading, ... }
//
// deps 约定（main-gantt 提供）：
//   sched / planStore / userStore / render（重绘，通常为 renderAll 包装）
//   getCtx   - () => 当前渲染 ctx（需含 X/dayW 供拖拽预览）
//   viewState- { view, zoom, collapsed, dayW }（可变共享对象，render 读取）
//   setDayW(dw) / toggleReportExpanded(name)
//   workday / today() / PNAME
//   getEl(id) / gantt / gsc / doc（缺省用 document）
// ============================================================
import { $, bindTip, toast as toastFn } from '../utils/dom.js';
import { isReadonly, enterReadonly } from '../utils/readonly.js';
import { PNAME as defaultPNAME } from '../core/default-data.js';
import { bindToolbar } from './toolbar.js';
import { bindWorkFilter } from './work-filter.js';
import { bindVersionPage } from './version-page.js';
import { bindDrawers } from './drawers.js';
import { bindModals } from './modals.js';
import { bindResLib } from './reslib.js';
import { bindThemePicker } from './theme-picker.js';
import { bindSetSync } from './sync-status.js';
import { showLoading, hideLoading } from './loading.js';
import { bindDrag, bindGscDrag, startBarDrag, startMsDrag, consumeSuppress } from './drag.js';

// 主聚合入口
export function bindAll(rawDeps) {
  const doc = rawDeps.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('bindAll: 需要 Document（doc）依赖');

  // ---- 1. 归一化公共依赖 ----
  const deps = {
    ...rawDeps,
    doc,
    getEl: rawDeps.getEl || (id => doc.getElementById(id)),
    gantt: rawDeps.gantt || doc.getElementById('gantt'),
    gsc: rawDeps.gsc || doc.querySelector('.gscroll'),
    toast: rawDeps.toast || (msg => toastFn(msg, doc)),
    bindTip: rawDeps.bindTip || bindTip,
    PNAME: rawDeps.PNAME || defaultPNAME,
    isReadonly: rawDeps.isReadonly || isReadonly,
    workday: rawDeps.workday,
    today: rawDeps.today || (() => new Date()),
    consumeSuppress
  };

  // ---- 2. 共享状态（抽屉 <-> reslib 交互） ----
  const shared = { activeTaskId: null, modalRes: [] };
  deps.shared = shared;

  // ---- 3. 绑定各组件（拖拽/抽屉等内部按需回读 deps） ----
  const toolbar = bindToolbar(deps);
  const drawers = bindDrawers(deps);
  const modals = bindModals(deps);
  const reslib = bindResLib(deps);
  // 资源工作视图的筛选条（委托在 #gantt 上，只绑一次；导出单文件入口自行调用同一个函数）
  const workFilter = bindWorkFilter(deps);
  // 版本（迭代）页面：同样把 [data-ver-*] 委托在 #gantt 上，一次绑定
  const versionPage = bindVersionPage(deps);
  const setSync = bindSetSync(deps);
  const themePicker = bindThemePicker(deps);
  deps.reslib = reslib;  // 供抽屉内「管理资源」入口点击时调用
  deps.modals = modals;  // 供抽屉内编辑需求按钮点击时调用
  deps.drawers = drawers; // 供 modals 的「新增任务」打开抽屉新建模式
  deps.themePicker = themePicker; // 供 toolbar 的「更多」弹层里「顶栏配色」项调用

  // 供 reslib 在任务抽屉打开时刷新资源分配选择器
  deps.renderResPicker = () => drawers.renderResPicker();

  // 拖拽全局事件（mousemove/mouseup）与空白滚动
  const unbindDrag = bindDrag(deps);
  bindGscDrag(deps);
  deps.startBarDrag = startBarDrag;
  deps.startMsDrag = startMsDrag;

  // ---- 4. 重绘后绑定甘特交互（每次 render 后调用） ----
  // main-gantt 的 render 包装器应在 innerHTML 更新后调用 this.afterRender()
  const afterRender = () => {
    drawers.bindGanttInteractions();
    toolbar.updateUndoRedoBtns();  // 刷新撤销/重做按钮状态
  };

  // ---- 5. render ctx 注入回调（供 renderAll / main-gantt 使用） ----
  const ctxInjection = {
    openDrawer: (taskId) => drawers.openTaskDrawer(taskId),
    openModal: (type) => {
      if (type === 'task') drawers.openNewTaskDrawer();
      else if (type === 'module') modals.openNewModModal();
      else if (type === 'reslib') reslib.openResLib();
    },
    openEditModModal: (modName) => modals.openEditModModal(modName),
    onDragStart: (type, taskId) => {
      if (type === 'bar') return (e) => startBarDrag(e, taskId, deps);
      if (type === 'ms') return (e) => startMsDrag(e, taskId, deps);
      return null;
    },
    updateProblemBadge: () => drawers.updateProblemBadge(),
    openProblemDrawer: () => drawers.openProblemDrawer(),
    closeDrawer: () => drawers.closeDrawer(),
    toggleReportExpanded: rawDeps.toggleReportExpanded
  };

  // 全局键盘快捷键：Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做（在 toolbar.js 中绑定），
  // Esc 关闭当前弹窗/抽屉（在 bindAll 中绑定，因其需访问 drawers/modals/reslib 引用）
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // 忽略输入框中的 Esc（不关闭）
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    // 优先关闭上下文菜单（由 context-menu 自身监听，但兜底关闭）
    // 弹窗 > 抽屉 > 上下文菜单
    // 需求抽屉与任务抽屉同为 .drawer（用 open 态），排在弹窗之后、抽屉之前
    const verModal = doc.getElementById('verModal');
    if (verModal && verModal.classList.contains('show')) { versionPage.closeModal(); return; }
    const modNew = doc.getElementById('modNewDrawer');
    if (modNew && modNew.classList.contains('open')) { modals.closeNewModModal(); return; }
    const themeModal = doc.getElementById('themeModal');
    if (themeModal && themeModal.classList.contains('show')) { themePicker.close(); return; }
    const resLib = doc.getElementById('resLibModal');
    if (resLib && resLib.classList.contains('show')) { reslib.closeResLib(); return; }
    const resEdit = doc.getElementById('resEditModal');
    if (resEdit && resEdit.classList.contains('show')) { reslib.closeResLib(); return; }
    const probD = doc.getElementById('probDrawer');
    if (probD && probD.classList.contains('open')) { drawers.closeDrawer(); return; }
    const taskD = doc.getElementById('taskDrawer');
    if (taskD && taskD.classList.contains('open')) { drawers.closeDrawer(); return; }
  });
  if (rawDeps.readonlyOnInit) enterReadonly(doc);

  return {
    // 渲染 ctx 注入（传给 renderAll / 视图层）
    ctxInjection,
    // 每次重绘后调用，重新绑定甘特内交互事件
    afterRender,
    // 各组件 API（供 main-gantt 按需使用）
    toolbar,
    drawers,
    modals,
    reslib,
    workFilter,
    versionPage,
    themePicker,
    setSync,
    loading: { showLoading: () => showLoading(doc), hideLoading: () => hideLoading(doc) },
    unbindDrag,
    // 便捷：同步状态钩子（挂到 sched.onSyncStatus 或直接使用）
    onSyncStatus: setSync
  };
}
