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
import { resolveAccess, ctxOf, ACCESS } from './permission.js';
import { $ } from './dom.js';

// 只读模式下禁用/灰化的编辑类按钮 id（原有清单里扣掉 FULL_ONLY 那 5 个 —— 两组是"拆"不是"叠"）
// 末尾的 mAddTask 为移动端操作条上的同功能按钮（代理到桌面按钮，需同步灰化避免误导）
// 注意：这些按钮对"协作者"仍然可用（协作者要能新增任务 / 新增需求看问题）
// ⚠️ 不要把 FULL_ONLY 的 id 再放回来：readonly 状态下 FULL_ONLY 那组由下面的 `noFull`
//   （ro || access !== full）覆盖，两组合起来仍是完整清单；叠放只会让"两组互不重叠"这条契约失效。
export const READONLY_BTN_IDS = [
  'btnAddTask', 'btnAddModule', 'btnProblems', 'mAddTask'
];

// 仅"全权用户"（管理员 / 所属人）可用的按钮 —— 它们要么重算整份 plan，要么改项目级数据：
//   btnAutoPlan  全量重排所有自动任务（会动到别人负责的任务）
//   btnUndo/Redo 回滚整份 plan 快照（会连带回滚别人的改动）
//   btnImport    整份替换 modules + resources + versions
//   btnResLib    资源库改名会级联重写全项目任务里的人名
// （「项目周期」按钮已随 cycle.js 的改造移除，不在任何一组里）
export const FULL_ONLY_BTN_IDS = ['btnAutoPlan', 'btnUndo', 'btnRedo', 'btnImport', 'btnResLib'];

// 根据当前只读状态刷新各编辑按钮的 disabled 样式与只读徽标。
// 导出供入口层调用：协作者 readonly === false 时 enterReadonly/leaveReadonly 都不会触发，
// 若不显式调一次，FULL_ONLY 那组永远不会灰化（见 main-gantt 的 initProject）。
export function refreshUI(doc) {
  const ro = !!userStore.state.readonly;
  const byId = id => $('#' + id, doc);
  const roBadge = $('roBadge', doc);
  if (roBadge) roBadge.style.display = ro ? '' : 'none';
  // body 级标记：移动端顶条据此显示「只读」胶囊（#roBadge 在移动端被隐藏）
  if (doc && doc.body) doc.body.classList.toggle('readonly-mode', ro);

  READONLY_BTN_IDS.forEach(id => {
    const el = byId(id);
    if (el) el.classList.toggle('disabled', ro);
  });
  // 协作者：编辑类按钮保留，但"动整份 plan / 项目级数据"的按钮要灰掉
  const noFull = ro || ctxOf(userStore.state).access !== ACCESS.FULL;
  FULL_ONLY_BTN_IDS.forEach(id => {
    const el = byId(id);
    if (el) el.classList.toggle('disabled', noFull);
  });
}

// 进入只读：写 userStore.state.readonly = true，并刷新 UI
export function enterReadonly(doc) {
  userStore.set({ readonly: true });
  refreshUI(doc);
}

// 退出只读：不能只把 readonly 置 false —— access 还停在旧值上。
// 若旧值是 'readonly'，permission.ctxOf 的向后兼容兜底（非 collab/full 一律视作 full）
// 会把它翻成 full：只读用户点一下切换就成了全权。故这里用身份真源重算 access。
// 注意：兜底本身是 Task 1 的既定契约（"先装守卫、后放权"的前提），只在写入侧修。
export function leaveReadonly(doc) {
  const s = userStore.state;
  const access = resolveAccess({
    role: s.role,
    isOwner: !!s.isOwner,
    resourceName: s.resourceName
  });
  userStore.set({ readonly: access === ACCESS.READONLY, access });
  refreshUI(doc);
}

// 只读快照判断（供组件层"拖拽不响应/按钮禁用"使用）
export function isReadonly() { return !!userStore.state.readonly; }

// 重新导出 scheduler 的只读守卫（throw 语义保留给新增/导入类）
export { assertEditable };
