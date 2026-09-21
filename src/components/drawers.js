// ============================================================
// src/components/drawers.js — 抽屉与甘特交互的装配入口
//
// 这个文件原先有 1112 行，同时装着五件互不相干的事（任务抽屉、问题抽屉、右键菜单动作、
// 甘特交互、抽屉手势），改任何一处都得先翻过另外四块。现按职责拆成 5 个模块，本文件只负责
// 「按顺序装配 + 收敛对外 API」：
//
//   drawer-shell.js        抽屉外壳：面板状态（openPanel）/ 关闭 / 移动端下拉手势
//   task-drawer.js         任务详情抽屉：表单 / 资源分配 / 前置依赖 / 控件绑定
//   problem-drawer.js      排期问题抽屉 + 问题徽标 + 归档徽标
//   menu-actions.js        右键菜单的动作分发（会改数据：新建/编辑/删除/归档/折叠）
//   gantt-interactions.js  重绘后的甘特交互：tip / 折叠 / 行排序 / 任务条 / 悬浮联动
//
// 拆分的边界依据是"谁和谁共享可变状态"，因此依赖是单向的、无循环：
//   task-drawer → drawer-shell（面板状态）、task-drawer → problem-drawer（刷新徽标）
//   menu-actions → task-drawer（菜单动作要开抽屉）
//   gantt-interactions → menu-actions / task-drawer / problem-drawer
// 抽屉关闭时的跨模块收尾（如任务抽屉的"退出新建模式"）用 drawer-shell 的 onDrawerClose
// 回调注册，避免外壳反向依赖具体抽屉。
//
// 对外 API 与拆分前完全一致（components/index.js 与测试无需感知内部结构）。
// 依赖注入（deps）：
//   sched/workday/planStore/userStore/render/toast/isReadonly/getEl(按 id 取元素)/gantt/gsc
//   startBarDrag/startMsDrag（来自 drag.js，需注入到 deps 供拖拽复用）
//   getCtx：() => 当前渲染 ctx（提供 X/dayW 供右击换算日期、tip 等使用）
// ============================================================
import { bindDrawerShell, closeDrawer } from './drawer-shell.js';
import { bindTaskDrawer, openTaskDrawer } from './task-drawer.js';
import { bindProblemDrawer } from './problem-drawer.js';
import { bindGanttDelegates, bindGanttInteractions, paintModHover, pickDragHandle } from './gantt-interactions.js';

// 聚合入口：绑定所有抽屉/甘特交互，返回外部可用的抽屉 API
export function bindDrawers(deps) {
  const shell = bindDrawerShell(deps);      // 面板状态 + 关闭 + 移动端下拉手势（只需一次）
  const task = bindTaskDrawer(deps);        // 任务抽屉控件事件
  const problem = bindProblemDrawer(deps);  // 问题抽屉（无一次性绑定，只有按需渲染）
  bindGanttDelegates(deps);                 // 委托类绑定（悬浮联动）：容器不换，只绑一次
  return {
    openTaskDrawer: task.openTaskDrawer,
    openNewTaskDrawer: task.openNewTaskDrawer,
    openProblemDrawer: problem.openProblemDrawer,
    closeDrawer: shell.closeDrawer,
    updateProblemBadge: problem.updateProblemBadge,
    renderProbList: problem.renderProbList,
    renderResPicker: task.renderResPicker,
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

// 重导出：测试与外部按原路径引用（真实实现在 gantt-interactions.js）
export { paintModHover, pickDragHandle };
