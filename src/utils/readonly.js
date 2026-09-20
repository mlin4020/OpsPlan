// ============================================================
// src/utils/readonly.js — 只读模式控制
// 由 gantt-app.js 的 enterReadonly（1585-1594 行）迁移，改为基于 userStore.state.readonly。
// 职责：
//   1) enterReadonly/leaveReadonly：切换只读状态（写 userStore.state.readonly），
//      并同步 UI（只读徽标显隐 + 编辑类工具栏按钮 disabled 样式）
//   2) 重新导出 assertEditable：复用 scheduler/mutations 的只读守卫，供组件层判断可编辑
// 组件层与渲染层均通过 userStore.state.readonly 感知只读（无 window 全局）
// ============================================================
import { userStore } from '../store/user-store.js';
import { assertEditable } from '../scheduler/mutations.js';
import { $ } from './dom.js';

// 只读模式下需禁用/灰化的编辑类工具栏按钮 id（与源 enterReadonly 的清单一致）
// 末尾两个 m* 为移动端操作条上的同功能按钮（代理到桌面按钮，需同步灰化避免误导）
export const EDIT_BTN_IDS = [
  'btnAddTask', 'btnAddModule', 'btnAutoPlan', 'btnProblems', 'btnResLib', 'btnImport', 'btnUndo', 'btnRedo',
  'mAddTask'
];

// 根据当前只读状态刷新各编辑按钮的 disabled 样式与只读徽标
function refreshUI(doc) {
  const ro = !!userStore.state.readonly;
  const roBadge = $('roBadge', doc);
  if (roBadge) roBadge.style.display = ro ? '' : 'none';
  // body 级标记：移动端顶条据此显示「只读」胶囊（#roBadge 在移动端被隐藏）
  if (doc && doc.body) doc.body.classList.toggle('readonly-mode', ro);
  EDIT_BTN_IDS.forEach(id => {
    const el = $('#' + id, doc);
    if (el) el.classList.toggle('disabled', ro);
  });
}

// 进入只读：写 userStore.state.readonly = true，并刷新 UI
export function enterReadonly(doc) {
  userStore.set({ readonly: true });
  refreshUI(doc);
}

// 退出只读：写 userStore.state.readonly = false，并刷新 UI
export function leaveReadonly(doc) {
  userStore.set({ readonly: false });
  refreshUI(doc);
}

// 只读快照判断（供组件层"拖拽不响应/按钮禁用"使用）
export function isReadonly() { return !!userStore.state.readonly; }

// 重新导出 scheduler 的只读守卫（throw 语义保留给新增/导入类）
export { assertEditable };
