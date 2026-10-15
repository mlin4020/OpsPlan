// ============================================================
// src/utils/permission.js — 权限判定（纯函数，不碰 DOM / window / userStore）
//
// 这份规则与服务端 `assert_plan_editable`（deploy/supabase/migration.sql）逐条对应。
// 任何一条不一致都会表现为「前端能填、保存被拒」——改这里时必须同步改 SQL。
//
// 四种身份（设计文档 §5.1）：
//   管理员   profiles.role = 'admin'
//   所属人   projects.owner_id = 我
//   协作者   已登录 且 profiles.resource_name 非空
//   只读     其余（游客 / 登录了但没配人名）
// ============================================================

export const ACCESS = { FULL: 'full', COLLAB: 'collab', READONLY: 'readonly' };

// 由账号信息解析访问级别。
// resource_name 空白一律降级为只读 —— 这是刻意的收紧：login.html 有公开自助注册入口，
// 若"没配人名也能改需求/版本"，任何人注册一个账号即可动别人的需求。
export function resolveAccess({ role, isOwner, resourceName } = {}) {
  if (role === 'admin' || isOwner) return ACCESS.FULL;
  return (resourceName && String(resourceName).trim()) ? ACCESS.COLLAB : ACCESS.READONLY;
}

// 从 userStore.state 派生判定上下文。
// 向后兼容：改造前只有 readonly 一个布尔，未显式给 access 且非只读时等价于"能改"（full）。
// 这样 Task 7–9 的守卫改造是零行为变化，真正的放权发生在 Task 10（main-gantt 计算 access）。
export function ctxOf(state) {
  const s = state || {};
  const access = s.readonly
    ? ACCESS.READONLY
    : (s.access === ACCESS.COLLAB || s.access === ACCESS.FULL) ? s.access : ACCESS.FULL;
  return { access, rname: s.resourceName || '', role: s.role || 'user' };
}

// ⚠️ 别把 ctxOf 当成"身份映射"用。它是 userStore.state → ctx 的**适配层**：
//   身份映射（谁是什么身份）只有 resolveAccess 一处；
//   ctxOf 的 `else ACCESS.FULL` 是刻意的向后兼容兜底 —— 它只在 `readonly === false`
//   时够得到，而放权任务（Task 9）之前 main-gantt 对"非 owner 非 admin"一律
//   `readonly: true`，所以那一支在生产里到不了。
//   拿 ctxOf 去断言"没配人名 ⇒ 只读"会测到兜底行为而不是身份映射 —— 测试里要用 resolveAccess 现算。

export const isFull = ctx => !!ctx && ctx.access === ACCESS.FULL;
const isCollab = ctx => !!ctx && ctx.access === ACCESS.COLLAB;

// 里程碑：有 m 键即里程碑（与 scheduler/index.js:46 的 collect 判定一致）
export const isMilestone = b => !!(b && b.m);

// 任务的负责人里有没有我。
// res 为空数组 = 未分配的普通任务 = 待认领 → 协作者可编辑（设计文档 §5.3）
export function taskMine(t, rname) {
  if (!t || !Array.isArray(t.res)) return false;   // 里程碑没有 res 键 → 走里程碑分支
  if (t.res.length === 0) return true;
  return !!rname && t.res.includes(rname);
}

export const modMine = (mo, rname) => !!(mo && rname && mo.owner === rname);

// ---- 需求 ----
// 字段级：优先级/描述/文档/提出人/提出时间/生命周期/所属版本/排序
export const canEditModuleFields = ctx => isFull(ctx) || isCollab(ctx);
// 归属级：改名/删除/归档/转交
export const canManageModule = (mo, ctx) => isFull(ctx) || (isCollab(ctx) && modMine(mo, ctx.rname));

// ---- 任务 ----
export function canEditTask(t, ctx) {
  if (isFull(ctx)) return true;
  if (!isCollab(ctx)) return false;
  return taskMine(t, ctx.rname);
}

// ---- 里程碑（手动编辑口径）----
// 里程碑本身没有 res，若按 canEditTask 会被当成"未分配"而放行 —— 这是要避免的。
// "经由版本管理写入"的特许只在服务端实现（§6.4），前端一律按需求归属判定。
export const canEditMilestone = (ms, mo, ctx) => canManageModule(mo, ctx);

// 统一入口：按任务形态分流。级联遍历时用它，避免里程碑被误判
export const canTouchTask = (t, mo, ctx) =>
  isMilestone(t) ? canEditMilestone(t, mo, ctx) : canEditTask(t, ctx);

// ---- 项目级 ----
export const canEditResources = ctx => isFull(ctx);
export const canEditVersion = ctx => isFull(ctx) || isCollab(ctx);
export const canDeleteVersion = ctx => isFull(ctx);
export const canArchiveVersionMods = ctx => isFull(ctx);
export const canPlan = ctx => isFull(ctx);
export const canEditProjectMeta = ctx => isFull(ctx);
export const canDeleteProject = ctx => !!(ctx && ctx.role === 'admin');
export const canManageUsers = ctx => !!(ctx && ctx.role === 'admin');
