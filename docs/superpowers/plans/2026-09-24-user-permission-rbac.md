# 用户管理与项目/任务级权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通用户能建项目并只编辑属于自己的任务、需求按创建人归属细化权限，且这套规则由 Postgres RPC 在服务端强制。

**Architecture:** 权限判定的**唯一真源是判定函数**——同一组规则写两份实现：前端 `src/utils/permission.js`（纯函数，可单测）与服务端 `assert_plan_editable`（plpgsql）。RLS 的 `projects_update` 策略**保持原样**，协作者唯一的写入通道是新 RPC `save_plan`（`SECURITY DEFINER`），由它调用校验函数。前端 `assertEditable(throwing, target)` 从"全局布尔"改为"按目标粒度判定"，21 处调用点逐个传入目标。

**Tech Stack:** 原生 ES Module + Vite 5 + Vitest（无运行时依赖）；Supabase（Postgres + RLS + RPC）；plpgsql。

**Spec:** `docs/superpowers/specs/2026-09-24-user-permission-rbac-design.md`

## Global Constraints

- **判定真源**：设计文档 §5.2。改动必须**同时**落到 `src/utils/permission.js` 与 `deploy/supabase/migration.sql` 的 `assert_plan_editable`。两份不一致 = "前端能填、保存被拒"，是本次最大风险。
- **身份映射只有一处**：`resolveAccess`（谁是什么身份）。`ctxOf` 是 `userStore.state → ctx` 的**适配层**，带刻意的向后兼容兜底 —— **不要拿它断言身份**（测试里断言"没配人名 ⇒ 只读"必须用 `resolveAccess` 现算，用 `ctxOf` 会测到兜底行为）。
- **不测不可达状态**：不要手写真源产生不出来的 fixture（例如 `{ access:'collab', rname:'' }` —— `collab` 的定义就含"人名非空"）。这类断言测不到生产不变量，还会与判定函数的语义打架。
- **四种身份**：`access = 'full' | 'collab' | 'readonly'`。`full = role==='admin' || isOwner`；`collab = 已登录 且 resource_name 非空`；其余 `readonly`。
- **任务归属**：`taskMine(t) = t.res 是空数组 || rname ∈ t.res`。`res` **不是数组**（里程碑）时**返回 false**，走里程碑分支。
- **需求归属**：`modMine(mo) = mo.owner === rname`。`mo.owner` 缺失 = 无主。
- **里程碑手动编辑**：`canEditMilestone(ms, mo) = canManageModule(mo)`。
- **三处特许写入**（服务端，§6.4）：① 级联钉住 `manual:false→true` ② `versions` 有变化时放行版本成员的「上线」里程碑 ③ `unscheduled:true→false` 时放行该需求的「上线」里程碑。
- **「上线」里程碑口径**：复用 `isGoMs(b)`（`src/core/versions.js:100`）= `b.p === 'go' || /上线/.test(b.label)`，**不新造概念**。
- **错误码**：权限拒绝统一 `errcode '42501'`；项目不存在 `'P0002'`。前端按 `42501` 判定"权限拒绝 → 回滚"。
- **`readonly` 语义不变**：`readonly === (access === 'readonly')`。既有 19 个组件的 `isReadonly()` 调用点**一行都不改**。
- **`resource_name` 安全口径**：DB 默认 `NULL`，`handle_new_user()` **不写**，只有管理员能写，**迁移不回填**。
- **RLS 不改**：`projects_update` / `projects_insert` / `projects_delete` / `projects_select` 四个策略一字不改。
- **提交信息**：Conventional Commits。**分支**：`feature/用户与权限`（已从 `main` 创建）。

## MR 切分（每段结束都处于可用状态）

| MR | 含任务 | 结束时状态 |
|---|---|---|
| MR1 权限地基 | Task 1–2 | 纯新增，零行为变化 |
| MR2 服务端 | Task 3–6 | owner/admin 走 RPC 快路径，行为不变；协作者仍全局只读 |
| MR3 守卫 | Task 7、7b、8 | 守卫就位但仍不放权，零行为变化 |
| MR4 放权 | Task 9 | 协作者开始可写 |
| MR5 界面收敛 | Task 10、11、12、12b | 界面与规则一致 |
| MR6 用户与项目 + 收尾 | Task 13–15 | 可运维、可交付 |

共 **17 个任务**（Task 7b / 12b 是 2026-09-24 追加需求「资源工作视图支持编辑自己的任务进度」插入的两条，见 spec §9.1）。

**MR2 必须先于 MR4**：否则协作者在前端获准编辑、却被 RLS 拒绝保存。

---

## Phase 1 — 权限地基（纯新增，零行为变化）

### Task 1: 权限判定纯函数

**Files:**
- Create: `src/utils/permission.js`
- Test: `tests/permission.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ACCESS = { FULL:'full', COLLAB:'collab', READONLY:'readonly' }`
  - `resolveAccess({role, isOwner, resourceName}) => 'full'|'collab'|'readonly'`
  - `ctxOf(state) => { access, rname, role }` — 从 `userStore.state` 派生判定上下文
  - `isMilestone(b)` / `taskMine(t, rname)` / `modMine(mo, rname)`
  - `canEditModuleFields(ctx)` / `canManageModule(mo, ctx)`
  - `canEditTask(t, ctx)` / `canEditMilestone(ms, mo, ctx)` / `canTouchTask(t, mo, ctx)`
  - `canEditResources(ctx)` / `canEditVersion(ctx)` / `canDeleteVersion(ctx)` / `canArchiveVersionMods(ctx)` / `canPlan(ctx)` / `canEditProjectMeta(ctx)` / `canDeleteProject(ctx)` / `canManageUsers(ctx)`

- [ ] **Step 1: 写实现**

Create `src/utils/permission.js`：

```js
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
```

- [ ] **Step 2: 写测试**

Create `tests/permission.test.js`：

```js
import { describe, it, expect } from 'vitest';
import {
  ACCESS, resolveAccess, ctxOf, isMilestone, taskMine, modMine,
  canEditModuleFields, canManageModule, canEditTask, canEditMilestone, canTouchTask,
  canEditResources, canEditVersion, canDeleteVersion, canArchiveVersionMods,
  canPlan, canEditProjectMeta, canDeleteProject, canManageUsers
} from '../src/utils/permission.js';

// 注意：这里**不要**手写「collab + 空人名」这种组合的常量。
// 真源 resolveAccess 的定义就是「collab ⟺ 已登录 且 resource_name 非空」，
// 所以「没配人名」必然落到 readonly —— 手写一个 collab+空人名 的 fixture 是在测一个
// 真源永远产生不出来的状态（测试噪声，且会与 canEditTask/canEditModuleFields 的语义打架）。
// 「没配人名 ⇒ 只读」这条不变量由下面的 `ctxOf 派生` 用例现算来锁定。
const FULL = { access: ACCESS.FULL, rname: '张三', role: 'admin' };
const OWNER = { access: ACCESS.FULL, rname: '张三', role: 'user' };
const COLLAB = { access: ACCESS.COLLAB, rname: '张三', role: 'user' };
const READONLY = { access: ACCESS.READONLY, rname: '', role: 'user' };

describe('resolveAccess', () => {
  it('管理员与所属人都是 full，优先于人名', () => {
    expect(resolveAccess({ role: 'admin' })).toBe(ACCESS.FULL);
    expect(resolveAccess({ isOwner: true })).toBe(ACCESS.FULL);
    expect(resolveAccess({ role: 'admin', resourceName: '' })).toBe(ACCESS.FULL);
  });
  it('配了人名才是 collab，否则只读', () => {
    expect(resolveAccess({ resourceName: '张三' })).toBe(ACCESS.COLLAB);
    expect(resolveAccess({ resourceName: '  ' })).toBe(ACCESS.READONLY);
    expect(resolveAccess({})).toBe(ACCESS.READONLY);
    expect(resolveAccess()).toBe(ACCESS.READONLY);
  });
});

describe('ctxOf 向后兼容', () => {
  it('未指定 access 且非只读 → full（等价改造前的“能改”）', () => {
    expect(ctxOf({ readonly: false, resourceName: '', role: 'user' }).access).toBe(ACCESS.FULL);
  });
  it('readonly 为真压过 access', () => {
    expect(ctxOf({ readonly: true, access: ACCESS.FULL, role: 'admin' }).access).toBe(ACCESS.READONLY);
  });
  it('显式 access 被保留；空入参不炸', () => {
    expect(ctxOf({ readonly: false, access: ACCESS.COLLAB }).access).toBe(ACCESS.COLLAB);
    expect(() => ctxOf()).not.toThrow();
    expect(ctxOf().rname).toBe('');
    expect(ctxOf().role).toBe('user');
  });
});

describe('没配对应人员 ⇒ 只读 ⇒ 一切写权限为假', () => {
  // ⚠️ 必须用 `resolveAccess`（身份映射的真源）现算，**不能用 `ctxOf`**。
  //   ctxOf 是 `userStore.state → ctx` 的适配层，它对"未显式给 access 且非只读"
  //   有一个刻意的向后兼容兜底（返回 'full'，为了让「守卫改造」先于「放权」上线时零行为变化）。
  //   拿 ctxOf 去断言"没人名 ⇒ 只读"，测到的是那个兜底行为，不是身份映射 —— 两者不是一回事。
  //   手写常量（旧版的 NO_NAME）或误用适配层（本节的初版），都会造出真源产生不出来的状态。
  it('resolveAccess 把"有人名之外的一切"都落到只读', () => {
    expect(resolveAccess({ role: 'user', resourceName: '' })).toBe(ACCESS.READONLY);
    expect(resolveAccess({ role: 'user', resourceName: '   ' })).toBe(ACCESS.READONLY);
    expect(resolveAccess({ role: 'user' })).toBe(ACCESS.READONLY);
  });

  it('由真源派生的「人名缺失」ctx：一切写权限为假', () => {
    const access = resolveAccess({ role: 'user', resourceName: '' });
    const anon = { access, rname: '', role: 'user' };
    expect(access).toBe(ACCESS.READONLY);
    expect(canEditTask({ res: [] }, anon)).toBe(false);        // 连"未分配可认领"也不给
    expect(canEditTask({ res: ['张三'] }, anon)).toBe(false);
    expect(canEditModuleFields(anon)).toBe(false);
    expect(canManageModule({ owner: '张三' }, anon)).toBe(false);
    expect(canPlan(anon)).toBe(false);
  });
});

describe('taskMine', () => {
  it('未分配的普通任务（res 空数组）任何人可编辑', () => {
    expect(taskMine({ res: [] }, '张三')).toBe(true);
    expect(taskMine({ res: [] }, '')).toBe(true);
  });
  it('res 含我 / 不含我', () => {
    expect(taskMine({ res: ['张三', '李四'] }, '张三')).toBe(true);
    expect(taskMine({ res: ['李四'] }, '张三')).toBe(false);
    expect(taskMine({ res: ['李四'] }, '')).toBe(false);
  });
  it('里程碑没有 res 键 → false（不能当成“未分配”）', () => {
    expect(taskMine({ m: '2026-09-09', label: '上线' }, '张三')).toBe(false);
  });
});

describe('modMine', () => {
  it('归属匹配才为真；无主 / 无人名 → false', () => {
    expect(modMine({ owner: '张三' }, '张三')).toBe(true);
    expect(modMine({ owner: '李四' }, '张三')).toBe(false);
    expect(modMine({}, '张三')).toBe(false);
    expect(modMine({ owner: '张三' }, '')).toBe(false);
    expect(modMine(null, '张三')).toBe(false);
  });
});

describe('任务级判定', () => {
  it('full 全放行', () => expect(canEditTask({ res: ['李四'] }, FULL)).toBe(true));
  it('collab 只看归属', () => {
    expect(canEditTask({ res: ['张三'] }, COLLAB)).toBe(true);
    expect(canEditTask({ res: [] }, COLLAB)).toBe(true);
    expect(canEditTask({ res: ['李四'] }, COLLAB)).toBe(false);
  });
  it('readonly 一律拒绝', () => {
    expect(canEditTask({ res: [] }, READONLY)).toBe(false);
    expect(canEditTask({ res: ['张三'] }, READONLY)).toBe(false);
    expect(canEditTask({ res: ['李四'] }, READONLY)).toBe(false);
  });
});

describe('需求级判定', () => {
  it('字段级：full 与 collab 都可以，readonly 不行', () => {
    expect(canEditModuleFields(FULL)).toBe(true);
    expect(canEditModuleFields(COLLAB)).toBe(true);
    expect(canEditModuleFields(READONLY)).toBe(false);
  });
  it('归属级：collab 仅限自己的需求，无主需求也不行', () => {
    expect(canManageModule({ owner: '李四' }, FULL)).toBe(true);
    expect(canManageModule({ owner: '张三' }, COLLAB)).toBe(true);
    expect(canManageModule({ owner: '李四' }, COLLAB)).toBe(false);
    expect(canManageModule({}, COLLAB)).toBe(false);
    expect(canManageModule({ owner: '张三' }, READONLY)).toBe(false);
  });
});

describe('里程碑与统一入口', () => {
  const ms = { m: '2026-09-09', label: '9/9 上线' };
  const task = { res: ['李四'] };
  it('isMilestone 只认 m 键', () => {
    expect(isMilestone(ms)).toBe(true);
    expect(isMilestone(task)).toBe(false);
    expect(isMilestone(null)).toBe(false);
  });
  it('里程碑手动编辑跟需求归属走（不是任务 res）', () => {
    expect(canEditTask(ms, COLLAB)).toBe(false);
    expect(canEditMilestone(ms, { owner: '张三' }, COLLAB)).toBe(true);
    expect(canEditMilestone(ms, { owner: '李四' }, COLLAB)).toBe(false);
  });
  it('canTouchTask 按形态分流', () => {
    expect(canTouchTask(task, { owner: '张三' }, COLLAB)).toBe(false);   // 普通任务：看 res
    expect(canTouchTask(ms, { owner: '张三' }, COLLAB)).toBe(true);      // 里程碑：看需求归属
    expect(canTouchTask(task, { owner: '李四' }, FULL)).toBe(true);
    expect(canTouchTask(ms, { owner: '李四' }, READONLY)).toBe(false);
  });
});

describe('其余判定', () => {
  it('资源库 / 自动计划 / 项目元数据 / 版本删除 / 一键归档：仅 full', () => {
    [canEditResources, canPlan, canEditProjectMeta, canDeleteVersion, canArchiveVersionMods]
      .forEach(fn => {
        expect(fn(FULL)).toBe(true);
        expect(fn(COLLAB)).toBe(false);
        expect(fn(READONLY)).toBe(false);
      });
  });
  it('版本编辑：full 与 collab', () => {
    expect(canEditVersion(FULL)).toBe(true);
    expect(canEditVersion(COLLAB)).toBe(true);
    expect(canEditVersion(READONLY)).toBe(false);
  });
  it('删项目与用户管理：仅管理员（所属人也不行）', () => {
    expect(canDeleteProject(FULL)).toBe(true);
    expect(canDeleteProject(OWNER)).toBe(false);
    expect(canManageUsers(FULL)).toBe(true);
    expect(canManageUsers(OWNER)).toBe(false);
    expect(canManageUsers(COLLAB)).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run tests/permission.test.js`
Expected: PASS（22 个用例。**不要**照旧版简报写的"约 27"去凑数——那是初版的估算，`NO_NAME` 那 3 条删掉、新增 2 条之后就是 22）

- [ ] **Step 4: 跑全量测试确认没有影响既有用例**

Run: `npm test`
Expected: PASS，且用例总数比改造前多出本次新增数

- [ ] **Step 5: 提交**

```bash
git add src/utils/permission.js tests/permission.test.js
git commit -m "feat(权限): 新增 permission.js 权限判定纯函数与真值表测试"
```

---

### Task 2: 需求归属字段 `module.owner`

**Files:**
- Modify: `src/scheduler/mutations.js:286-306`（`addModule` 的对象字面量）
- Modify: `src/scheduler/mutations.js:409-410` 之后（`updateModule` 转交）
- Test: `tests/scheduler.test.js`（新增 describe 块）

**Interfaces:**
- Consumes: `userStore.state.resourceName`（Task 10 起才会有值；在此之前为空串）
- Produces: 需求对象新增可选字段 `owner: string | undefined`。**缺失 = 无主**。

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.js` 末尾追加：

```js
describe('scheduler: 需求归属 owner', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('addModule 默认把归属写成当前用户的人名', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '张三' });
    sched.addModule({ name: '归属需求', autoCreate: false });
    expect(planStore.state.modules.find(m => m.name === '归属需求').owner).toBe('张三');
  });

  it('addModule 没配人名时不写归属（不臆造）', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '' });
    sched.addModule({ name: '无主需求', autoCreate: false });
    const mo = planStore.state.modules.find(m => m.name === '无主需求');
    expect('owner' in mo).toBe(false);
  });

  it('opts.owner 可显式指定（供转交/导入用）', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '张三' });
    sched.addModule({ name: '指定归属', autoCreate: false, owner: '李四' });
    expect(planStore.state.modules.find(m => m.name === '指定归属').owner).toBe('李四');
  });

  it('addModule 归属人名带空格会被 trim', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '  张三  ' });
    sched.addModule({ name: '去空格', autoCreate: false });
    expect(planStore.state.modules.find(m => m.name === '去空格').owner).toBe('张三');
  });

  it('updateModule 支持转交归属', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '张三' });
    sched.addModule({ name: '待转交', autoCreate: false });
    sched.updateModule({ name: '待转交', owner: '李四' });
    expect(planStore.state.modules.find(m => m.name === '待转交').owner).toBe('李四');
  });

  it('updateModule 传空串 = 清除归属（回到无主），与 desc/docUrl 同口径', () => {
    const sched = makeSched();
    const mo = planStore.state.modules.find(m => m.name === '官网改版');
    mo.owner = '张三';
    sched.updateModule({ name: '官网改版', owner: '' });
    expect('owner' in planStore.state.modules.find(m => m.name === '官网改版')).toBe(false);
  });

  it('不传 owner 时 updateModule 不动归属（patch 语义）', () => {
    const sched = makeSched();
    const mo = planStore.state.modules.find(m => m.name === '官网改版');
    mo.owner = '张三';
    sched.updateModule({ name: '官网改版', pri: 'P0' });
    expect(planStore.state.modules.find(m => m.name === '官网改版').owner).toBe('张三');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.js -t "需求归属"`
Expected: FAIL —— 第一条 `expected undefined to be '张三'`

- [ ] **Step 3: 在 `addModule` 里写入归属**

⚠️ **不能在对象字面量里写 `owner: ... || undefined`**。`{ owner: undefined }` 是**有键**的（`'owner' in mo === true`），
于是内存里"看起来有归属"、而 `JSON.stringify` 又会把 `undefined` 值的键丢掉 → **内存形状与落库形状不一致**。
所以必须"空值就不写字段"：

`src/scheduler/mutations.js`，在 `const mo = { … };` 对象字面量（现 `:286-306`）**之后**、`if (opts.unscheduled) …` 之前插入：

```js
    // 需求归属人（设计文档 §4.2）：默认 = 当前登录用户对应的人名。
    //   有归属 → 该人对这个需求有全部权限（改名/删除/归档/转交）
    //   没配人名 / 老数据缺失 → 键不存在 = 无主，归属级操作仅项目所属人·管理员，不臆造归属
    //
    // 注意：这里必须"空值就不写字段"，不能写成字面量里的 `owner: ... || undefined` ——
    //   `{ owner: undefined }` 是**有键**的，会让 `'owner' in mo` 这类存在性判断误判为"有归属"；
    //   而 JSON.stringify 又会丢掉该键，于是内存与落库形状不一致。
    const owner = (opts.owner != null ? String(opts.owner) : String(userStore.state.resourceName || '')).trim();
    if (owner) mo.owner = owner;
```

（`userStore` 已在 `mutations.js:15` 导入，无需新增 import。）

**本任务此时 `userStore.state.resourceName` 还不存在**（Task 9 才加），所以恒为空 → 不写字段。
这是刻意的零行为变化；**不要**为了让测试好看去改 `user-store.js`。

- [ ] **Step 4: 在 `updateModule` 里支持转交**

`src/scheduler/mutations.js`，在 `if (opts.pri != null || 'pri' in opts) mo.pri = normalizePriority(opts.pri);`（现 `:410`）之后插入：

```js
    // 需求归属转交（归属级操作，权限见 Task 7）：传空串 = 清除（回到无主），
    // 与 desc / docUrl 的"传空串 = 清除"口径一致（字段直接 delete，不留空串）
    if ('owner' in opts) {
      const ow = String(opts.owner || '').trim();
      if (ow) mo.owner = ow; else delete mo.owner;
    }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.js`
Expected: PASS（含新增 7 条）

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS。特别注意 `tests/views.test.js` / `tests/export.test.js` 里若有对需求对象做**全字段深比较**的用例，新增 `owner` 可能让它变红——若红，逐条确认是"多了一个字段"而不是行为变更，然后更新该断言。

- [ ] **Step 7: 提交**

```bash
git add src/scheduler/mutations.js tests/scheduler.test.js
git commit -m "feat(需求): 新增 module.owner 归属字段，addModule 默认归属当前用户"
```

---

### Task 12: 需求弹窗（名字置灰 + 归属字段）与台账/版本页/资源库收敛

**Files:**
- Modify: `src/components/shell.js`（需求弹窗 DOM：新增「归属」输入）
- Modify: `src/components/modals.js:258-308`（读取/回显/保存）
- Modify: `src/components/req-page.js:178,193,202,255`
- Modify: `src/components/version-page.js:14,35,136,146-188,199`
- Modify: `src/components/reslib.js:39-82`
- Test: `tests/views.test.js`、`tests/req-page.test.js`

**Interfaces:**
- Consumes: Task 1 的 `ctxOf` / `canManageModule` / `canEditModuleFields` / `canDeleteVersion` / `canArchiveVersionMods` / `canEditResources`
- Produces: 需求对象可经弹窗写入 `owner`（转交）

- [ ] **Step 1: 需求弹窗加「归属」输入**

`src/components/shell.js` 的需求弹窗里，紧跟「提出人」那一行之后加：

```html
    <div class="field">
      <label>归属（谁对这个需求有全部权限）</label>
      <input type="text" id="inpModOwner" list="modOwnerList" placeholder="留空 = 无主，仅项目所属人与管理员可管理">
      <datalist id="modOwnerList"></datalist>
    </div>
```

- [ ] **Step 2: `modals.js` 读取 / 回显 / 保存**

① 顶部 import 追加：

```js
import { ctxOf, canManageModule, canEditModuleFields } from '../utils/permission.js';
```

② 新增两个读取/填充函数（照 `readModPri()` 的模式）：

```js
// 归属：datalist 候选来自数据里出现过的人名（避免管理员/需求创建人拼错。
// 拼错的后果是"归属到不存在的人"，该需求从此没人能改名/删除）
function fillOwnerOptions(mods, doc) {
  const dl = doc.getElementById('modOwnerList');
  if (!dl) return;
  const names = new Set();
  (mods || []).forEach(m => { if (m.owner) names.add(m.owner); });
  (mods || []).forEach(m => (m.bars || []).forEach(b => (b.res || []).forEach(r => names.add(r))));
  dl.innerHTML = [...names].sort().map(n => `<option value="${esc(n)}"></option>`).join('');
}
function readModOwner(doc) {
  const el = doc.getElementById('inpModOwner');
  return el ? String(el.value || '').trim() : '';
}
```

③ 打开弹窗时：填充候选 + 回显 + 按权限置灰。在 `openNewModModal` 里，归属默认填当前用户人名：

```js
  const ownerEl = doc.getElementById('inpModOwner');
  ownerEl.value = userStore.state.resourceName || '';
  ownerEl.disabled = false;
```

在 `openEditModModal` 里：

```js
  fillOwnerOptions(planStore.state.modules, doc);
  const c = ctxOf(userStore.state);
  const ownerEl = doc.getElementById('inpModOwner');
  ownerEl.value = mo.owner || '';
  // 归属是"归属级"字段：只有需求创建人 / 项目所属人 / 管理员能改
  ownerEl.disabled = !canManageModule(mo, c);

  // 需求名同理 —— 服务端 diff 里"改名"和"删旧增新"同形，
  // 靠"新需求 bars 与被删需求深度相等"识别；前端提前置灰，避免"填了却存不进"
  const nameEl = doc.getElementById('inpModName');
  nameEl.disabled = !canManageModule(mo, c);
  nameEl.title = nameEl.disabled ? '该需求不是你创建的，无权改名（改名与删除同一权限）' : '';
```

④ 保存时提交归属：在 `btnNewModSave` 的 `sched.addModule({...})` 参数里加 `owner: readModOwner(doc),`；在 `btnEditModSave` 的 `sched.updateModule({...})` 参数里加 `owner: readModOwner(doc),`（**但置灰时不要传**，否则会试图转交而被服务端拒）：

```js
  const ownerEl = doc.getElementById('inpModOwner');
  if (!ownerEl.disabled) opts.owner = readModOwner(doc);
```

- [ ] **Step 3: 台账 `req-page.js` 的归档/删除显隐**

在渲染行内操作按钮的地方（现 `:178,193,202,255` 附近），把归档/删除按钮的渲染包一层权限判断：

```js
  const c = ctxOf(userStore.state);
  // …渲染时…
  const canManage = canManageModule(mo, c);
  // 归档开关与删除按钮：只有需求创建人 / 项目所属人 / 管理员可点
  const actHtml = canManage
    ? `${archiveBtn}${delBtn}`
    : '';
```

（字段级行内编辑 —— 生命周期 / 提出人 / 所属版本 —— **保持放开**，因为它们走 `canEditModuleFields`。）

- [ ] **Step 4: 版本页 `version-page.js` 收敛**

在 `:14,35,136,199` 的 `isReadonly()` 判断之外，对两个按钮单独加权限：

```js
  const c = ctxOf(userStore.state);
  // 「删除版本」与「一键归档本版本需求」是全权动作：
  //   删版本会一次性解绑里面所有需求，误操作影响面比删单个需求大；
  //   一键归档会批量改成员需求的 archived（归属级字段）
  const showDanger = canDeleteVersion(c) && canArchiveVersionMods(c);
```

渲染时把「删除版本」「一键归档本版本需求」两个按钮按 `showDanger` 显隐。**其余版本操作（新建/编辑/标记上线/改成员/改所属版本）对协作者保持放开。**

- [ ] **Step 5: 资源库 `reslib.js` 收敛**

资源库改名会级联重写全项目任务里的人名（`mutations.js` 的 `renameResourceRefs`），属全权动作。入口按钮 `btnResLib` 已在 Task 10 灰化；再给弹窗内的保存/删除按钮加同一道判断，避免从其他路径进入：

```js
  // …渲染每行按钮时…
  const c = ctxOf(userStore.state);
  if (!canEditResources(c)) return '';   // 不渲染保存/删除按钮
```

- [ ] **Step 6: 补测试**

`tests/views.test.js`：「协作者视角下，非自己创建的需求行不渲染归档/删除按钮；自己创建的渲染」。
`tests/req-page.test.js`：「协作者对无主需求的归档按钮不可用；字段级行内编辑（生命周期）仍可用」。

- [ ] **Step 7: 跑测试 + 手工验证**

Run: `npm test`
手动：协作者打开自己创建的需求 → 名字可改、归属可改；打开他人需求 → 名字置灰、归属置灰、其余字段可改；版本页 → 无「删除版本」「一键归档」。

- [ ] **Step 8: 提交**

```bash
git add src/components/ tests/views.test.js tests/req-page.test.js
git commit -m "feat(权限): 需求弹窗支持归属转交，台账/版本页/资源库按权限收敛"
```

---

### Task 12b: 资源工作视图的进度编辑（界面）

> **插入位置**：紧跟 Task 12，属于 MR5。设计见 spec §9.1；数据层见 Task 7b。
> **范围**：只做**资源工作视图**（`work` 视图）。「工作组规划器」（`res` 视图，时间轴视角）**不在本次范围**。

**Files:**
- Modify: `src/views/work-view.js`（`taskRow` 的进度格加编辑标记；`renderWorkView` 注入 `canEdit`）
- Create: `src/components/work-task.js`
- Modify: `src/components/index.js`（挂载 `bindWorkTask`）
- Modify: `src/main-gantt.js`（`baseCtx` 注入 `canEditProgress`）
- Modify: `src/styles/gantt.css`
- Test: `tests/work-view.test.js`（新增用例）

**Interfaces:**
- Consumes: Task 7b 的 `sched.setProgress(taskId, pct)`；Task 1 的 `ctxOf`
- Produces:
  - `ctx.canEditProgress(t) => boolean`（由入口注入，**不注入时视图一律按不可编辑**）
  - `deps.canEdit(t)`（视图内传给 `taskRow`）
  - `bindWorkTask(deps) => { close }`

- [ ] **Step 1: 视图侧：可编辑的行才带编辑标记**

`src/views/work-view.js` 的 `taskRow()`，把进度格那一行（现 `:116`）替换为：

```js
  // 进度格：只有可编辑的行才带 data-wk-prog。
  // 不可编辑的行连属性都不渲染 —— 从 DOM 层面保证点不动，
  // 而不是"渲染了再在事件里判断后 return"（后者留下一个假的可点区域，用户会反复点）
  const canEdit = typeof deps.canEdit === 'function' && deps.canEdit(t);
  return `<div class="rwk-row">
    …
    <span class="rwk-prog${canEdit ? ' is-edit' : ''}"${
      canEdit ? ` data-wk-prog="${esc(t.id)}" data-wk-done="${pct}" role="button" tabindex="0"` : ''
    } title="${canEdit ? '点击修改完成度' : `完成度 ${pct}%`}"><span class="rwk-bar"><i style="width:${pct}%;background:${fill}"></i></span><b class="rwk-pct">${pct}%</b></span>
  </div>`;
```

`renderWorkView()` 里构造 `deps` 时（现 `:174`）加上 `canEdit`：

```js
  // 可编辑口径由入口注入（spec §9.1）：full 全部 · collab 只有 res 含自己 · 未注入一律 false。
  // 刻意走 ctx 注入而不是在视图里 import userStore：
  //   视图要保持可脱离浏览器渲染（导出单文件就没有 userStore），不注入即安全只读
  const canEditProgress = typeof ctx.canEditProgress === 'function' ? ctx.canEditProgress : () => false;
  const deps = { modPri, modColors: ctx.modColors, filter, canEdit: canEditProgress };
```

- [ ] **Step 2: 入口注入 `canEditProgress`**

`src/main-gantt.js` 的 `baseCtx`（现 `:111-121`）里加：

```js
    // 资源工作视图的进度编辑口径（spec §9.1）：
    //   full  → 所有行（含未分配）
    //   collab → 只有 res 含我名字的行
    //   readonly → 无
    // 刻意比全局口径更窄：未分配任务在本页只读（认领请去甘特图）。
    // 注意这是"前端比服务端更严"：服务端 bar_owned 对 res:[] 是放行的，别误判成服务端漏判。
    canEditProgress: t => {
      const c = ctxOf(userStore.state);
      if (c.access === 'full') return true;
      if (c.access !== 'collab') return false;
      return !!t.res && t.res.includes(c.rname);
    },
```

`main-gantt.js` 顶部 import 追加 `ctxOf`：
```js
import { resolveAccess, ACCESS, ctxOf } from './utils/permission.js';
```

`src/main-standalone.js` **不要**注入（导出件没有 userStore，不注入即自动只读）—— 这也是必须走注入而不是视图内 import 的原因。

- [ ] **Step 3: 新建 `src/components/work-task.js`**

```js
// ============================================================
// components/work-task.js — 资源工作视图：点击修改任务完成度
//
// 为什么单独成模块（不塞进 work-filter.js）：
//   work-filter 管"看哪些"，这里管"改什么"，两件事生命周期完全不同 ——
//   筛选器只在筛选条上委托；本模块要弹层、要读权限、要提交 mutation。
//
// 为什么不做拖拽（spec §9.1）：
//   进度条填充宽 = pct%，pct=0 时没有任何可命中元素；轨道仅约 60px 宽，
//   拖一下 2% 一跳、手机上拖不准。改成"点整格 + 弹层输入"两个问题一并消失。
// ============================================================
import { $ } from '../utils/dom.js';

const PRESETS = [0, 25, 50, 75, 100];   // 档位
const STEP = 5;                         // 步进幅度

export function bindWorkTask(deps) {
  const g = deps.gantt;
  if (!g || typeof g.addEventListener !== 'function') return null;

  const doc = deps.doc;
  let pop = null;      // 弹层根元素
  let curId = null;    // 正在编辑的任务 id

  function close() {
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    curId = null;
  }

  function commit(pct) {
    if (!curId) return;
    const v = deps.sched.setProgress(curId, pct);
    if (v === null) {
      // 被守卫拦下（权限变了 / 任务被删 / 里程碑）：给出明确原因，别让它静默失败
      if (deps.onSyncStatus) deps.onSyncStatus('fail', { msg: '无法修改该任务的完成度' });
      close();
      return;
    }
    close();
    deps.render();        // 进度条与状态徽标一起更新（状态由 done 推导）
    if (deps.onSyncStatus) deps.onSyncStatus('ok', { msg: `完成度已更新为 ${v}%` });
  }

  function open(cell) {
    curId = cell.dataset.wkProg;
    let val = Math.max(0, Math.min(100, parseInt(cell.dataset.wkDone || '0', 10) || 0));
    const rect = cell.getBoundingClientRect();

    pop = doc.createElement('div');
    pop.className = 'wkp';
    pop.innerHTML =
      '<div class="wkp-h">完成度</div>' +
      '<div class="wkp-row"><input class="wkp-n" type="number" min="0" max="100" step="1" value="' + val + '"><b>%</b>' +
        '<button type="button" class="wkp-b" data-wkp-dial="-1">−' + STEP + '</button>' +
        '<button type="button" class="wkp-b" data-wkp-dial="1">+' + STEP + '</button></div>' +
      '<div class="wkp-presets">' +
        PRESETS.map(p => '<button type="button" class="wkp-b" data-wkp-set="' + p + '">' + p + '%</button>').join('') +
      '</div>' +
      '<div class="wkp-foot"><button type="button" class="wkp-b primary" data-wkp-ok>保存</button>' +
        '<button type="button" class="wkp-b" data-wkp-cancel>取消</button></div>';
    doc.body.appendChild(pop);
    // 贴在进度格下方；靠近屏幕右/下边缘时回收，避免被裁掉
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - w - 8)) + 'px';
    pop.style.top = Math.min(rect.bottom + 6, doc.documentElement.clientHeight - h - 8) + 'px';

    const input = pop.querySelector('.wkp-n');
    const clamp = () => {
      const n = parseInt(input.value, 10);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : val;
    };
    pop.querySelectorAll('[data-wkp-set]').forEach(b => b.addEventListener('click', () => {
      val = parseInt(b.dataset.wkpSet, 10); input.value = val;
    }));
    pop.querySelectorAll('[data-wkp-dial]').forEach(b => b.addEventListener('click', () => {
      val = clamp() + STEP * parseInt(b.dataset.wkpDial, 10); val = Math.max(0, Math.min(100, val));
      input.value = val;
    }));
    pop.querySelector('[data-wkp-ok]').addEventListener('click', () => commit(clamp()));
    pop.querySelector('[data-wkp-cancel]').addEventListener('click', close);
    // Enter 保存 / Esc 取消：这是"快改一条再下一条"的场景，键盘路径必须顺手
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(clamp()); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.focus();
    input.select();
  }

  g.addEventListener('click', e => {
    const cell = e.target.closest && e.target.closest('[data-wk-prog]');
    if (!cell) {
      // 点弹层内部不关（上面的按钮各自处理），点外部才关
      if (pop && !(e.target.closest && e.target.closest('.wkp'))) close();
      return;
    }
    if (pop && curId === cell.dataset.wkProg) { close(); return; }   // 再点同一格 = 收起
    close();
    open(cell);
  });

  return { close };
}
```

- [ ] **Step 4: 挂载**

`src/components/index.js`：照 `bindWorkFilter` 的模式

```js
import { bindWorkTask } from './work-task.js';
// …在 const workFilter = bindWorkFilter(deps); 之后…
  // 资源工作视图的进度编辑（点击弹层）。与 workFilter 同属 work 视图，
  // 但一个管"看哪些"、一个管"改什么"，故分开两个模块
  const workTask = bindWorkTask(deps);
```

并在返回对象里加 `workTask,`。

- [ ] **Step 5: 样式**

`src/styles/gantt.css` 追加：

```css
/* 资源工作视图：进度格可点击态（不可编辑的行不加 .is-edit，光标也就不变） */
.rwk-prog.is-edit{cursor:pointer;border-radius:4px;transition:background .15s}
.rwk-prog.is-edit:hover{background:var(--accent-soft)}
.rwk-prog.is-edit:focus-visible{outline:2px solid var(--accent-ring);outline-offset:1px}

/* 进度编辑弹层（移动端按钮保持 ≥40px 触摸高度） */
.wkp{position:fixed;z-index:80;background:#fff;border:1px solid var(--line);border-radius:10px;
  box-shadow:0 10px 30px rgba(15,23,42,.18);padding:10px 12px;min-width:196px}
.wkp-h{font-size:11px;font-weight:800;color:var(--muted);margin-bottom:6px}
.wkp-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.wkp-n{width:62px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:14px;font-family:inherit}
.wkp-presets{display:flex;gap:6px;margin-bottom:8px}
.wkp-b{min-height:34px;min-width:34px;padding:6px 9px;font-size:12px;border:1px solid var(--line);
  background:#fff;border-radius:7px;cursor:pointer;font-family:inherit;color:#334155}
.wkp-b:hover{border-color:var(--accent);color:var(--accent)}
.wkp-b.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.wkp-foot{display:flex;gap:6px;justify-content:flex-end}
@media(max-width:640px){ .wkp-b{min-height:40px;padding:8px 12px;font-size:13px} .wkp-n{min-height:40px} }
```

- [ ] **Step 6: 视图测试**

`tests/work-view.test.js` 追加：

```js
describe('work-view: 进度编辑标记', () => {
  it('注入 canEditProgress 时，可编辑的行带 data-wk-prog', () => { /* 断言渲染结果含 data-wk-prog="<id>" */ });
  it('未注入 canEditProgress 时一行都不带（导出件安全只读）', () => { /* 断言渲染结果不含 data-wk-prog */ });
  it('canEdit 返回 false 的行不带 data-wk-prog', () => { /* 用 () => false 注入 */ });
  it('pct = 0 的行仍然可点（编辑标记与填充宽无关）', () => { /* done=0 且 canEdit=true → 仍带属性 */ });
});
```
（按 `tests/work-view.test.js` 里既有用例的方式构造 `ctx` 与 `state`，断言渲染出的 HTML 字符串。）

- [ ] **Step 7: 跑测试 + 手工验证**

Run: `npm test`

手动（协作者账号，`resourceName = 张三`）：

| 场景 | 预期 |
|---|---|
| 资源工作视图，点自己任务的进度格 | 弹出输入层，默认值 = 当前百分比 |
| 输入 40 → 保存 | 进度条变 40%，提示"完成度已更新为 40%"。**状态徽标按 `taskStatus` 重算**：`done>=100` → 已完成；否则结束日已过且有人负责 → 已逾期；否则今日落在 `[s,e]` 内 → 进行中；否则未开始（`core/task-status.js:62-71`）。所以改到 40 不一定显示"进行中"，取决于该任务的日期区间——**别把这条当成失败** |
| 输入 100 → 保存 | 进度条满格，状态**一定**变「已完成」（`done>=100` 是最高优先级判定） |
| 输入 140 / -5 | 被钳制为 100 / 0 |
| 点档位 50% / 步进 +5 / −5 | 输入框数字相应变化 |
| Enter / Esc | 保存 / 取消 |
| 点弹层外部 | 关闭，不保存 |
| 点**别人**任务的进度格 | 无反应，光标不变（该行没有 `data-wk-prog`） |
| 点「未分配」区块里任务的进度格 | 无反应（本页对未分配只读，认领请去甘特图） |
| Ctrl+Z | 撤销回改之前的百分比 |
| 管理员账号 | 所有行（含未分配）都能点 |
| 只读账号 / 导出的单文件 HTML | 所有行都点不动 |

- [ ] **Step 8: 提交**

```bash
git add src/views/work-view.js src/components/work-task.js src/components/index.js src/main-gantt.js src/styles/gantt.css tests/work-view.test.js
git commit -m "feat(资源工作视图): 点击修改自己的任务完成度（按归属收敛，未分配本页只读）"
```

---

## Phase 6 — 用户管理与项目页

### Task 13: 用户管理页（编辑用户 + 指定对应人员）

**Files:**
- Modify: `src/services/projects.js`（`setAdmin` → `updateProfile`；新增 `listResourceNames`）
- Modify: `src/services/backends/supabase.js:85-89` 与新增方法
- Modify: `src/services/backends/feishu.js:93-`（同签名改造）
- Modify: `index.html`（编辑用户弹窗 + 样式）
- Modify: `src/main-index.js:83-106`（列表渲染）、`:251`（按钮绑定）
- Test: `tests/services.test.js`（`projects` 门面透传）

**Interfaces:**
- Consumes: Task 3 的 `resource_name` 列、Task 5 的 `list_resource_names()` RPC
- Produces:
  - `projects.updateProfile(userId, patch) => Promise<{error}>`（`patch: {display_name?, role?, resource_name?}`）
  - `projects.listResourceNames() => Promise<{data: string[], error}>`

- [ ] **Step 1: 服务门面改造**

`src/services/projects.js`：

```js
// 用户管理
export function listUsers() { return call('listUsers'); }
export function listUserOptions() { return call('listUserOptions'); }
// 编辑用户：改名 / 改角色 / 指定"对应人员"。取代原来的 setAdmin(userId)
//（setAdmin 无法表达"降级为普通用户"与"指定人名"，而这两件正是本次要补的）
export function updateProfile(userId, patch) { return call('updateProfile', userId, patch); }
export function listResourceNames() { return call('listResourceNames'); }
```

默认导出同步替换 `setAdmin` → `updateProfile`，并加 `listResourceNames`。

- [ ] **Step 2: Supabase 后端实现**

**先补一个漏掉的字段**：`src/services/backends/supabase.js` 的 `listUsers`（现 `:67-74`）select 是 `'id,display_name,role,created_at'`，**没有 `resource_name`**。Step 5 要渲染它来做「未指定」徽标，不加的话**徽标会永远显示、漏配发现机制直接失效**：

```js
      .select('id,display_name,role,resource_name,created_at')
```

然后把 `setAdmin` 替换为：

```js
  // 编辑用户：只允许改这三个字段 —— role 与 resource_name 由服务端的
  // profiles_guard_sensitive 触发器兜底，非管理员改会被拒（42501）
  async updateProfile(userId, patch = {}) {
    const miss = needClient();
    if (miss) return miss;
    const body = {};
    if (patch.display_name != null) body.display_name = String(patch.display_name).trim();
    if (patch.role != null) body.role = patch.role === 'admin' ? 'admin' : 'user';
    if (patch.resource_name != null) {
      const rn = String(patch.resource_name).trim();
      body.resource_name = rn || null;      // 空串 → NULL = 未指定（只读）
    }
    return getClient().from('profiles').update(body).eq('id', userId);
  },

  async listResourceNames() {
    const miss = needClient();
    if (miss) return miss;
    const { data, error } = await getClient().rpc('list_resource_names');
    if (error) return { data: null, error };
    return { data: (data || []).map(r => r.name), error: null };
  },
```

- [ ] **Step 3: 飞书后端对齐（仅签名与字段，不做校验）**

`src/services/backends/feishu.js`：把 `setAdmin(userId, isAdmin)` 改名为 `updateProfile(userId, patch)`，内部按 `patch.role === 'admin'` 推断 `isAdmin`，并透传 `display_name`；`listResourceNames` 直接返回 `{ data: [], error: null }` 并在注释里写明"飞书模式不提供候选，靠人工填写"。

同时检查 `listUsers`（现 `:81-85`）与 `listUserOptions` 的返回映射，**确保 `resource_name` 被透出**——飞书那边它是人员表的一个字段，取不到就返回空串（而不是 `undefined`），否则 Step 5 的「未指定」徽标逻辑要额外防 `undefined`。

- [ ] **Step 4: `index.html` 加编辑用户弹窗**

在 `#maskNewUser` 之后插入：

```html
<div class="modal-mask" id="maskEditUser">
  <div class="modal">
    <h3>编辑用户</h3>
    <div class="field"><label>姓名</label><input type="text" id="inpEuName"></div>
    <div class="field"><label>角色</label>
      <select id="selEuRole">
        <option value="user">普通用户</option>
        <option value="admin">管理员</option>
      </select>
    </div>
    <div class="field">
      <label>对应人员（任务里的负责人名字）</label>
      <input type="text" id="inpEuResName" list="resNameList" placeholder="留空 = 只能查看，不能编辑">
      <datalist id="resNameList"></datalist>
    </div>
    <div class="err" id="euErr"></div>
    <div class="modal-foot">
      <button class="btn primary" id="btnEuSave">保存</button>
      <span class="spacer"></span>
      <button class="btn ghost" id="btnEuCancel">取消</button>
    </div>
  </div>
</div>
```

- [ ] **Step 5: `main-index.js` 渲染「对应人员」列与编辑入口**

把 `loadUsers()`（现 `:83-106`）替换为：

```js
async function loadUsers() {
  if (!isAdmin()) return;
  const { data, error } = await listUsers();
  if (error) return;
  const ul = $('userList');
  ul.innerHTML = (data || []).map(u => {
    const isMe = u.id === me.id;
    // 「未指定」是本次的漏配发现机制：没配 resource_name 的人登录后是纯只读，
    // 而"为什么我什么都不能改"在界面上完全没有别的线索 —— 必须在这里显式标出来
    const rn = (u.resource_name || '').trim();
    const rnCell = rn
      ? '<span class="time">' + esc(rn) + '</span>'
      : '<span class="badge warn" title="未指定对应人员：该账号登录后只能查看，不能编辑">未指定</span>';
    return '<div class="user-row">' +
      '<span class="avatar" style="background:' + (u.role === 'admin' ? '#f59e0b' : '#3b82f6') + '">' + esc((u.display_name || '?').slice(0, 1)) + '</span>' +
      '<span style="font-weight:600">' + esc(u.display_name || '--') + '</span>' +
      (u.role === 'admin' ? '<span class="badge admin">管理员</span>' : '') +
      (isMe ? '<span class="badge">我</span>' : '') +
      rnCell +
      '<span class="spacer"></span>' +
      '<span class="time">' + fmtTime(u.created_at) + '</span>' +
      '<button class="btn sm ghost" data-edituser="' + u.id + '">编辑</button>' +
    '</div>';
  }).join('');
  ul.querySelectorAll('[data-edituser]').forEach(b => b.addEventListener('click', () => openEditUser(b.dataset.edituser, data)));
}
```

- [ ] **Step 6: `main-index.js` 编辑逻辑与两条保护**

在 `saveNewUser` 之后插入：

```js
let editingUser = null;

// 候选人名：拼错的 resource_name 会让那人"什么都改不了"且极难排查，所以必须给候选
async function fillResNameOptions() {
  const { data } = await listResourceNames();
  const dl = $('resNameList');
  if (dl && data) dl.innerHTML = data.map(n => '<option value="' + esc(n) + '"></option>').join('');
}

function openEditUser(id, users) {
  const u = (users || []).find(x => x.id === id);
  if (!u) return;
  editingUser = u;
  $('inpEuName').value = u.display_name || '';
  $('selEuRole').value = u.role === 'admin' ? 'admin' : 'user';
  $('inpEuResName').value = u.resource_name || '';
  $('euErr').textContent = '';

  // 保护①：不能改自己的角色 —— 误操作把自己降级后就没人能改回来了
  const isMe = u.id === me.id;
  $('selEuRole').disabled = isMe;
  $('selEuRole').title = isMe ? '不能修改自己的角色' : '';

  // 保护②：不能降级最后一个管理员 —— 否则系统会没有管理员
  const adminCount = (users || []).filter(x => x.role === 'admin').length;
  const isLastAdmin = u.role === 'admin' && adminCount <= 1;
  if (isLastAdmin) {
    $('selEuRole').disabled = true;
    $('selEuRole').title = '这是最后一个管理员，不能降级';
  }
  $('maskEditUser').classList.add('show');
}

async function saveEditUser() {
  if (!editingUser) return;
  const patch = {
    display_name: $('inpEuName').value.trim(),
    resource_name: $('inpEuResName').value.trim()
  };
  if (!$('selEuRole').disabled) patch.role = $('selEuRole').value;

  const { error } = await updateProfile(editingUser.id, patch);
  if (error) { $('euErr').textContent = errMsg(error); return; }
  closeModal('maskEditUser');
  loadUsers();
  fillOwnerSelects();
}
```

- [ ] **Step 7: 绑定事件与样式**

① `bindEvents()` 里把 `$('btnNewUser')` 那行之后补：

```js
  $('btnEuSave').addEventListener('click', saveEditUser);
  $('btnEuCancel').addEventListener('click', () => closeModal('maskEditUser'));
```

② `enterApp()` 里 `loadUsers()` 之后补 `fillResNameOptions();`

③ `index.html` 的 `<style>` 里加"未指定"徽标样式：

```css
.badge.warn{background:#f59e0b;color:#fff}
```

④ `main-index.js` 顶部 import 从 `./services/projects.js` 增加 `updateProfile, listResourceNames, errMsg`，并从 `./services/projects.js` 移除 `setAdmin`。

- [ ] **Step 8: 跑测试 + 手工验证**

Run: `npm test`
手动（管理员账号）：
| 场景 | 预期 |
|---|---|
| 用户列表 | 每行有「编辑」按钮；未配人名的显示橙色「未指定」 |
| 编辑某人：改名 + 设为普通用户 + 指定「张三」 | 保存成功，列表刷新，该行显示绿色"张三" |
| 编辑自己 | 「角色」下拉置灰，tooltip 提示不能改自己的角色 |
| 把唯一的管理员降级 | 「角色」下拉置灰，tooltip 提示"这是最后一个管理员" |
| 「对应人员」输入框 | 输入时有候选（来自 `list_resource_names()`） |
| 用被指定为「张三」的账号登录后进入项目 | 能编辑 `res` 含张三的任务 |
| 把该账号的对应人员清空后再登录 | 全站只读，工具栏全灰 |

- [ ] **Step 9: 提交**

```bash
git add src/services/ index.html src/main-index.js
git commit -m "feat(用户管理): 支持编辑用户（改名/角色/对应人员）与未指定人员提示"
```

---

### Task 14: 项目页——普通用户能管理自己的项目

**Files:**
- Modify: `src/main-index.js:64-81`（卡片渲染）、`:185-213`（编辑/删除）
- Test: 无（纯 DOM 渲染，靠手工验证；项目页没有独立测试文件）

**Interfaces:**
- Consumes: `me.role` / `p.owner_id`
- Produces: 无新导出

- [ ] **Step 1: 「管理」按钮对所属人也显示**

`src/main-index.js` 的 `renderProjects()`（现 `:64-81`），把 `canEdit` 与「管理」按钮两行替换为：

```js
  grid.innerHTML = projects.map(p => {
    const isOwner = !!me && p.owner_id === me.id;
    const canEdit = !!me && (isOwner || isAdmin());            // 未登录(me=null)一律只读
    // 「管理」入口：所属人也要有 —— 原来只对 admin 显示，导致普通用户
    // 建了项目却改不了自己的项目名/周期（这是"普通用户可建项目"的实际缺口）
    const canManage = isOwner || isAdmin();
    return '<div class="proj-card">' +
      '<div class="proj-name">' + esc(p.name || '未命名') +
        '<span class="owner-tag">' + (canEdit ? (isOwner ? '我的' : '管理员') : '只读') + '</span>' +
      '</div>' +
      '<div class="time">更新时间：' + fmtTime(p.updated_at) + '</div>' +
      '<div class="proj-actions">' +
        '<button class="btn sm primary" onclick="location.href=\'gantt.html?project=' + p.id + '\'">' + (canEdit ? '进入编辑' : '只读查看') + '</button>' +
        (canManage ? '<button class="btn sm ghost" data-edit="' + p.id + '">管理</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
```

- [ ] **Step 2: 编辑弹窗按身份收敛，删除仅管理员**

① `openEditProj(id)`：补一句控制删除按钮显隐

```js
function openEditProj(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  editingProj = p;
  $('inpEditProjName').value = p.name || '';
  const sel = $('selEditProjOwner');
  const opt = Array.from(sel.options).find(o => o.value === p.owner_id);
  if (opt) sel.value = p.owner_id;
  // 删除项目仅管理员：RLS 的 projects_delete 策略就是 is_admin()，前端不放开
  $('btnDelProj').style.display = isAdmin() ? '' : 'none';
  $('editProjErr').textContent = '';
  $('maskEditProj').classList.add('show');
}
```

② `saveEditProj()`：换负责人加二次确认 + 明确警告

```js
async function saveEditProj() {
  if (!editingProj) return;
  const name = $('inpEditProjName').value.trim();
  const ownerId = $('selEditProjOwner').value;
  const changingOwner = ownerId && ownerId !== editingProj.owner_id;

  if (changingOwner) {
    // 转交会让原所属人当场失去管理权（RLS 的 projects_update 只认 owner_id），
    // 且不可自恢复 —— 必须说清楚再让他点
    const target = Array.from($('selEditProjOwner').options).find(o => o.value === ownerId);
    const who = target ? target.textContent : ownerId;
    if (!confirm('确认把项目「' + editingProj.name + '」转交给「' + who + '」？\n\n' +
                 '转交后你将失去对该项目的管理权（连项目名都改不了），需要管理员才能改回。')) return;
  }

  const { error } = await updateProject(editingProj.id, { name: name || editingProj.name, owner_id: ownerId });
  if (error) { $('editProjErr').textContent = error.message; return; }
  closeModal('maskEditProj');
  loadProjects();
}
```

- [ ] **Step 3: 手工验证**

| 场景 | 预期 |
|---|---|
| 普通用户建一个项目 | 成功，卡片标签显示「我的」，有「管理」按钮 |
| 该用户点「管理」 | 能改名、能换负责人；**没有**「删除项目」按钮 |
| 该用户改自己项目的名字 | 保存成功 |
| 该用户把项目转交给别人 | 弹二次确认；确认后保存成功，卡片变成「只读」且「管理」按钮消失 |
| 管理员点「管理」 | 有「删除项目」按钮 |
| 普通用户看别人的项目 | 只有「只读查看」，无「管理」按钮 |

- [ ] **Step 4: 提交**

```bash
git add src/main-index.js
git commit -m "feat(项目): 所属人可管理自己的项目（改名/换负责人），删除仍仅管理员"
```

---

## Phase 7 — 收尾

### Task 15: 全量回归、导出模板重建、部署清单

**Files:**
- Modify: `public/export-template.html`（由构建产物生成，不手改）
- Modify: `README.md`（权限模型与首次部署步骤）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可发布的构建产物与运维步骤

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全绿（19 个文件 / 566+ 用例）。

> **基线说明（2026-10-15 更正）**：本计划早期版本提醒"`tests/auth.test.js` 有 3 条既失败用例
> （`friendlyAuthError` 未映射为中文）"——**这句已过期**，那 3 条已被 `262e3ee`（登录拆独立路由）
> 顺手修掉了（那次正好改了 `src/services/auth.js`）。Task 1 执行时实测 `auth.test.js` 6/6 全绿。
> 也就是说：**基线是全绿，出现任何失败都是本次改动引入的**，别再拿"本来就红"当挡箭牌。

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功

- [ ] **Step 3: 重建导出模板（改了 `src/` 就必须做）**

Run: `npm run build:export`
Expected: `public/export-template.html` 更新。导出件全程只读（`main-standalone.js` 固定 `isReadonly: () => true`），本次权限改造不应改变它的行为——**打开导出的单文件 HTML 确认仍然只能看不能改**。

- [ ] **Step 4: 端到端矩阵手测（三种身份 × 关键操作）**

| 身份 | 进入非自己所属的项目 | 能改自己任务 | 能改他人任务 | 能改需求字段 | 能改名/删需求 | 资源库 | 自动计划 | 用户管理 |
|---|---|---|---|---|---|---|---|---|
| 管理员 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 所属人 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 协作者（已配人名） | ✅ | ✅ | ❌ | ✅ | 仅自己的需求 | ❌ | ❌ | ❌ |
| 登录但未配人名 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 游客（未登录） | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

- [ ] **Step 5: 用 curl 绕过前端验证服务端真的兜得住**

对协作者账号，直接构造一个"改别人任务"的 plan 调 RPC：

```bash
curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/save_plan" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $COLLAB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"p_project_id":"<项目id>","p_plan":<把别人任务的 e 改一天的完整 plan>}'
```
预期：返回 `42501` 与中文原因，且库里 plan **未被修改**。

再直连 PATCH projects（不经过 RPC）：
```bash
curl -sS -X PATCH "$SUPABASE_URL/rest/v1/projects?id=eq.<项目id>" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $COLLAB_TOKEN" \
  -H "Content-Type: application/json" -d '{"plan":{}}'
```
预期：RLS 拒绝（返回空数组，0 行被更新）。

- [ ] **Step 6: 更新 `README.md`**

在「多项目与权限」那一节补：

1. 四种身份与判定口径（指向 `docs/superpowers/specs/2026-09-24-user-permission-rbac-design.md`）
2. **首次部署必须做的事**：执行 `deploy/supabase/migration.sql` 后，用管理员账号在「用户管理」里**逐个指定"对应人员"**——在此之前所有账号都是只读（这是 `resource_name` 默认 NULL 的必然代价）
3. 明确写出「细粒度权限由 `save_plan` RPC 在服务端强制；`projects_update` 策略未放宽，直连写仍被 RLS 拒绝」
4. **必须改掉「把第一个账号提成管理员」那段引导**。它现在写的是：
   ```sql
   update public.profiles set role = 'admin' where display_name = '你的名字';
   ```
   Task 3 的守卫触发器装上之后，**这条 SQL 会被拒**（实测 `REJECT: 42501`）——触发器对所有角色生效，
   而 SQL 控制台里 `auth.uid()` 是 NULL → `is_admin()` 为 false。
   改成：
   ```sql
   -- 已经跑过 migration.sql 的库：临时关触发器
   alter table public.profiles disable trigger profiles_guard_sensitive;
   update public.profiles set role = 'admin' where display_name = '你的名字';
   alter table public.profiles enable trigger profiles_guard_sensitive;

   -- 或者：先建账号再跑 migration.sql（顺序反过来，最省事）
   ```
   并在「多项目与权限」一节写明这条边界：**应用内的管理员改角色不受影响**（走 `updateProfile`，带管理员 JWT），
   受影响的只有"在 SQL 控制台直接改"。理由见 spec §13 对应风险行。

- [ ] **Step 7: 提交**

```bash
git add public/export-template.html README.md
git commit -m "chore(权限): 重建导出模板并补充权限模型与首次部署说明"
```

---

## 部署清单

> **2026-10-15 更正**：本项目**能通过 Supabase MCP 自动化**（`supabase_apply_migration` / `supabase_execute_sql`），
> 不再是"只能手工执行"。迁移由各任务的 Step 用 MCP 应用并当场验证（见 Phase 2 的验证手法）。

**已在执行中完成的部分**：Task 3 / 4 / 5 的迁移由各自任务的 Step 应用，且当场跑验证用例。

**仍需人工的一件事**（MCP 做不到，与"谁是哪个人的名字"有关）：

1. 用管理员账号登录 → 「用户管理」→**逐个给账号指定「对应人员」**
2. 指定完成后，让每个协作者登录验证"能改自己的任务"

> ⚠️ **这条依赖 Task 13**：App 侧写 `resource_name` 的能力是 Task 13 才加的（`supabase.js` 的
> `updateProfile`；当前的 `setAdmin` 只写 `role`，`listUsers` 连 `resource_name` 都没 select）。
> 而"用 SQL 控制台直接改"这条路被 **Task 3 自己的守卫触发器**拦住了（`auth.uid()` 为 NULL → 42501）。
> **所以在 Task 13 落地之前，没有任何已实现的路径能给账号配「对应人员」** —— 这期间所有人保持只读。
> 这是刻意的安全默认，但要按这个顺序理解：**Task 3 上线的同时就锁死了运维侧的补录通道，直到 Task 13 把它重新打开（走 App，带管理员 JWT）。**

**第 1 步之前全体只读**——这是 `resource_name` 默认 `NULL` 的必然代价，也是刻意的安全默认。
（真实库现有 4 个账号：李功林 / 张馨月 / test 是管理员，徐新是普通用户；他们都还没配「对应人员」。）

**部署后仍需人工核对的两项**：

- `deploy/supabase/migration.sql` 与线上库的一致性（本次已回填 `projects_select_anon` 漂移，但仍建议偶发核对一次）
- 若日后在别的项目从零建库：直接跑这份文件即可（含 `projects_select_anon`）

---

## Self-Review

**1. Spec 覆盖**

| Spec 章节 | 对应任务 |
|---|---|
| §3 修两处提权漏洞 | Task 3 |
| §4.1 `profiles.resource_name` | Task 3（列）+ Task 9（读）+ Task 13（写） |
| §4.2 `module.owner` | Task 2 |
| §5.1 四种身份 | Task 1（`resolveAccess`）+ Task 9（注入） |
| §5.2 判定函数 | Task 1 |
| §5.3 任务形态对应 | Task 1（`taskMine` 对无 `res` 返回 false）+ Task 8 |
| §5.4 逐操作权限表 | Task 7（数据层）+ Task 10–12（界面层） |
| §5.4 需求改名识别 | Task 4（`bars_norm` 比较） |
| §6.1 RLS 不改 | Task 3/4（未改任何策略，`migration.sql` 只做新增） |
| §6.2 `save_plan` | Task 4 |
| §6.3 `assert_plan_editable` | Task 4 |
| §6.3.1 级联依据校验 | Task 4（`v_moved`）+ Task 8（产生依据） |
| §6.4 三处特许写入 | Task 4（服务端校验）+ Task 8（级联产生） |
| §7 迁移清单 | Task 3/4/5 |
| §8.1 `permission.js` | Task 1 |
| §8.2 `userStore` 扩展 | Task 9 |
| §8.3 `assertEditable` 改造 | Task 7 |
| §8.4 级联断链 | Task 8 |
| §8.5 保存失败回滚 | Task 6 |
| §8.6 `undo/redo` 补守卫 | Task 7 |
| §9 UI 收敛 | Task 10/11/12 |
| §9.1 资源工作视图进度编辑（追加需求） | Task 7b（`setProgress` 数据层）+ Task 12b（界面） |
| §10.1 用户管理页 | Task 13 |
| §10.2 项目页 | Task 14 |
| §11 测试策略 | Task 1/2/6/7/8/9/10/11/12/15 |
| §13 风险 | Task 15 Step 4–6（端到端矩阵 + curl 绕过验证） |

**2. 占位符扫描**：无 `TBD` / `TODO` / "稍后补充"。Task 10 Step 3 与 Task 11 的站点清单以"先 grep 定位具体 id/行号"的方式给出——这是**必要的**，因为那些 id/行号会随代码漂移，写死反而会误导。

**3. 类型与命名一致性**：`access` / `resourceName` / `isOwner` / `taskMine` / `modMine` / `canTouchTask` / `canManageModule` / `canEditModuleFields` / `assertEditable(throwing, target)` / `save_plan` / `assert_plan_editable` / `bar_owned` / `plan_tasks` / `bars_norm` / `bar_norm` / `is_go_ms` / `only_manual_changed` / `list_resource_names` / `updateProfile` / `listResourceNames` 在全部任务中命名一致。

**4. 已发现并修正的问题**：
- Task 10 的提交信息里 `readoly` → `readonly`（已在计划正文改正）
- `bar_norm` 必须剔除 `mod` / `isMs` 这两个 `collect()` 写回的运行期字段，否则**需求改名会被误判成"批量修改任务"**，直接把协作者的合法改名拒掉。已在 Task 4 Step 1 注释中写明理由。
- Task 9 必须**同时**改 `getProfile` 的 select 与飞书后端返回值，否则协作者会被降级成只读，表现为"我明明配了人名却什么都不能改"。
- Task 12b 的手工验证里，"改完成度 → 状态徽标变成什么"由 `taskStatus` 的日期口径决定（`core/task-status.js:62-71`），**不是简单的 40% → 进行中**。只有 100% 必定是「已完成」。已在正文写清，避免实施者据此误报失败。
- 追加需求「资源工作视图进度编辑」的落地过程中纠正了两处我自己的判断错误：① 该视图**没有时间维度**（时间轴视角是 `res` 视图/工作组规划器，见 `work-view.js:5`），因此"时间视图下是否可编辑"这个问题不存在；② 选"点击输入"后，`pct=0` 无命中区的问题**自动消失**（那是拖拽方案才有的障碍）。

---

## Execution Handoff

计划完成，已保存到 `docs/superpowers/plans/2026-09-24-user-permission-rbac.md`。两种执行方式：

1. **Subagent-Driven（推荐）** —— 每个 Task 派一个全新的 subagent，任务之间我来 review，迭代快、上下文干净
2. **Inline Execution** —— 在当前会话里按 `executing-plans` 批量执行，带检查点

选哪种？

## Phase 2 — 服务端（可独立部署，owner/admin 行为不变）

> ### 验证方式（2026-10-15 更正：本阶段**可以真执行、真验证**，不要手工肉眼核对）
>
> 本项目已通过 **Supabase MCP 连上真实库**，并已实测以下能力：
>
> | 能力 | 用法 | 实测结论 |
> |---|---|---|
> | 应用迁移 | `supabase_apply_migration(name, query)` | 记入 `supabase_migrations.schema_migrations` |
> | 执行 SQL | `supabase_execute_sql(query)` | **支持多语句**、**支持事务** |
> | 模拟身份 | `select set_config('request.jwt.claims','{"sub":"<uuid>"}',false);` | ✅ `auth.uid()` 随之返回该 uuid |
> | 让 RLS 生效 | `set local role authenticated;` … `reset role;` | ✅ 执行角色默认是 `postgres`，**会绕过 RLS 但触发器照常触发** |
> | 安全改数据 | `begin; … ; rollback;` | ✅ `rollback` 生效，临时表被回收 |
>
> **四条硬性手法**（写用例时照做）：
> 1. `auth.uid()` 读 `request.jwt.claim.sub`，兜底读 `request.jwt.claims->>'sub'` → 用 `set_config` 伪装身份
> 2. 测**触发器**不必切角色（触发器总会触发）；测 **RLS** 才需要 `set local role authenticated`
> 3. **任何改动类验证都必须包在 `begin; … rollback;` 里**，绝不在真实行上留痕
> 4. 被拒的语句会中止事务 → 必须用 `do $$ begin … exception when others then … end $$;` 把它裹住，把结果写进**临时表**，最后 `select` 出来
>
> **库里有真实数据（4 个用户 / 1 个项目）**，验证用这两个身份：
> - 非管理员：`徐新` = `c6ff5485-65cc-4b90-85a1-1b3d4f7df70f`（`role=user`）
> - 管理员：`李功林` = `f65c4375-0c6f-49aa-81b5-4ea5cf4a8acb`（`role=admin`）
>
> 仍然**不要**给 SQL 编造 vitest 用例（Vitest 跑不到数据库）。

### Task 3: `resource_name` 列 + 敏感字段守卫触发器

**Files:**
- Modify: `deploy/supabase/migration.sql`（追加到文件末尾，保持单文件幂等）

**Interfaces:**
- Consumes: 无
- Produces: `profiles.resource_name text`（默认 NULL）；`guard_profile_sensitive()` 触发器函数

- [ ] **Step 1: 追加 SQL**

在 `deploy/supabase/migration.sql` 末尾追加：

```sql
-- ============================================================
-- 5. 用户与权限（2026-09-24 设计文档 §4.1 / §3）
-- ============================================================

-- ---------- 5.1 profiles.resource_name ----------
-- 该账号在任务 res / 需求 owner 里对应的人名。
--
-- ⚠️ 安全口径：默认必须 NULL，绝不自动取 display_name。
-- 注册时的 displayName 是用户在注册表单里自己填的；若自动继承，
-- 注册时姓名填「张三」即当场获得张三名下全部任务的编辑权。
-- 因此：不回填、handle_new_user 不写、只有管理员能写。
alter table public.profiles add column if not exists resource_name text;

-- ---------- 5.2 敏感字段守卫（UPDATE 与 INSERT 两条路都要堵） ----------
--
-- 修 UPDATE 路径的既有漏洞：profiles_update 策略只写了 using、没写 with check，
-- using 只回答"哪些行你能改"、不限制能改哪一列。于是任何登录用户都能：
--   PATCH /rest/v1/profiles?id=eq.<自己>  { "role": "admin" }
--   PATCH /rest/v1/profiles?id=eq.<自己>  { "resource_name": "张三" }
--
-- 同时堵 INSERT 路径：profiles_insert 策略是 with check (auth.uid() = id)，
-- 只限定了"只能插自己那行"，没限定字段。所以当自己的 profile 行不存在时
-- （管理员删过 / 异常），可以直接 INSERT 一行把 role 写成 'admin'。
-- 同一个触发器一并挡住 —— 两条路径是同一类问题。
--
-- 必须用触发器而不是 RLS 的 with check：UPDATE 的 with check 无法引用 OLD，
-- 在策略里查同表还会有可见性 / 竞态问题。
create or replace function public.guard_profile_sensitive()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- 新行一律按最小权限落地：非管理员不能给自己写 role / resource_name
    if not public.is_admin() then
      new.role := 'user';
      new.resource_name := null;
    end if;
  else
    if (new.role is distinct from old.role
        or new.resource_name is distinct from old.resource_name)
       and not public.is_admin() then
      raise exception '仅管理员可修改角色与对应人员' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_sensitive on public.profiles;
create trigger profiles_guard_sensitive
  before insert or update on public.profiles
  for each row execute function public.guard_profile_sensitive();
```

- [ ] **Step 1b: 顺手修一处仓库/真实库漂移（用户已批准，2026-10-15 发现）**

真实库里有 `projects_select_anon`（`to anon using (true)`），但**仓库的 `migration.sql` 从来没有它**——
它以独立迁移 `20260910021121 anon_readonly_projects` 应用过（见 `supabase_migrations.schema_migrations`），
却从没回填进本文件。后果：**拿这份文件从零建库时，游客只读模式会静默失效**（anon 读不到项目 → 项目列表页空白）。

继续追加到 `migration.sql` 末尾：

```sql
-- ---------- 5.2b 回填：anon 只读项目策略 ----------
-- 漂移修正：线上有、仓库文件没有（独立迁移 20260910021121 anon_readonly_projects 从未回填）。
-- 内容与线上完全一致，因此对线上是幂等重写；补上后本文件才能从零重建出当前库。
drop policy if exists "projects_select_anon" on public.projects;
create policy "projects_select_anon" on public.projects
  for select to anon using (true);
```

- [ ] **Step 2: 用 MCP 应用迁移，并确认幂等**

用 `supabase_apply_migration` 应用 Step 1 + Step 1b 的 SQL（名称建议 `user_permission_rbac_step1_resource_name_and_guard`）。

> **若你没有 `supabase_apply_migration` / `supabase_execute_sql` 工具**：**立刻回报 NEEDS_CONTEXT**，不要退化成"写好 SQL 就算完"。控制者会代为应用并把真实输出交给你继续验证。

然后再以 `supabase_execute_sql` **把同一段 SQL 重跑一遍**，确认**幂等**（第二遍不报错）。

- [ ] **Step 3: 验证加列生效且全为 NULL（不回填）**

```sql
select count(*) as total,
       count(*) filter (where resource_name is null) as null_cnt
  from public.profiles;
```
预期：`total = 4`、`null_cnt = 4`（**迁移不回填**，见 spec §4.1 的安全口径）。

- [ ] **Step 4: 验证两条提权路径都被堵住（四种情形一次跑完）**

按 Phase 2 的验证手法：全部包在 `begin; … rollback;` 里（**不在真实行上留痕**）；
被拒的语句裹在内部 `begin…exception` 里（避免把外层事务带崩），结果写进临时表再 `select`。

```sql
begin;
create temp table t_guard(label text, result text);
do $probe$
declare
  msg      text;
  c_xin    uuid := 'c6ff5485-65cc-4b90-85a1-1b3d4f7df70f';   -- 徐新（role=user）
  c_li     uuid := 'f65c4375-0c6f-49aa-81b5-4ea5cf4a8acb';   -- 李功林（role=admin）
  c_claims text;
begin
  -- ① 非管理员改自己的 role → 应被拒（Task 3 修的就是这条）
  c_claims := json_build_object('sub', c_xin)::text;
  perform set_config('request.jwt.claims', c_claims, false);
  begin
    update public.profiles set role = 'admin' where id = c_xin;
    msg := 'PASS(放行) <-- 不该发生！';
  exception when others then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end;
  insert into t_guard values ('① 非管理员改自己 role', msg);

  -- ② 非管理员改自己的 display_name → 应放行（触发器不能误伤改名）
  begin
    update public.profiles set display_name = display_name where id = c_xin;
    msg := 'PASS(放行)';
  exception when others then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end;
  insert into t_guard values ('② 非管理员改自己 display_name', msg);

  -- ③ 管理员改别人的 role → 应放行
  c_claims := json_build_object('sub', c_li)::text;
  perform set_config('request.jwt.claims', c_claims, false);
  begin
    update public.profiles set role = 'admin' where id = c_xin;
    msg := 'PASS(放行)';
  exception when others then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end;
  insert into t_guard values ('③ 管理员改别人 role', msg);

  -- ④ INSERT 路径：先让 profile 行不存在（模拟"被管理员删过"），再自建一行写 role='admin'
  --    整个过程都在外层事务里，rollback 后徐新的行原样回来
  c_claims := json_build_object('sub', c_xin)::text;
  perform set_config('request.jwt.claims', c_claims, false);
  begin
    delete from public.profiles where id = c_xin;
    insert into public.profiles (id, display_name, role, resource_name)
    values (c_xin, '徐新', 'admin', '张三');
    msg := 'PASS(插入成功)';
  exception when others then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end;
  insert into t_guard values ('④ 非管理员 INSERT', msg);

  -- ④ 的"静默改写"必须在同一事务内查（rollback 后就没了）
  insert into t_guard
  select '④ 插入后的实际值', coalesce(role,'<null>') || ' / ' || coalesce(resource_name,'<null>')
    from public.profiles where id = c_xin;
end $probe$;
select label, result from t_guard order by label;
rollback;
```

预期：

| 用例 | 期望结果 |
|---|---|
| ① 非管理员改自己 role | `REJECT: 42501 / 仅管理员可修改角色与对应人员` |
| ② 非管理员改自己 display_name | `PASS(放行)` |
| ③ 管理员改别人 role | `PASS(放行)` |
| ④ 非管理员 INSERT | `PASS(插入成功)` |
| ④ 插入后的实际值 | **`user / <null>`** —— 被静默改写成最小权限 |

> ④ 的判据是"**插入成功但值被改写**"，不是"报错"。理由见 spec §7.2：INSERT 路径用改写而不抛错，
> 是为了不破坏 `handle_new_user()` 之外可能存在的自建 profile 流程。
> **若报错（例如 FK violation `23503`）而不是被改写**，说明探针写错了（`auth.users` 里必须真有这个 id），
> 不是实现错了 —— 徐新的 id 在 `auth.users` 里存在，所以先 delete 再 insert 是合法的。

- [ ] **Step 5: 确认真实数据未被改动**

```sql
select id, display_name, role, resource_name from public.profiles order by created_at;
```
预期：**4 行**，`display_name` 与 `role` 与迁移前**完全一致**（李功林/张馨月/test = admin，徐新 = user），
`resource_name` **全为 NULL**。

> 若 `徐新` 变成 `admin`，说明 Step 4 的事务回滚没生效 —— **立即回报 BLOCKED**，别继续。

- [ ] **Step 6: 提交**

```bash
git add deploy/supabase/migration.sql
git commit -m "fix(权限): 关闭 profiles 提权漏洞，新增 resource_name 列与敏感字段守卫触发器"
```

---

### Task 4: `save_plan` RPC + `assert_plan_editable` 校验

**Files:**
- Modify: `deploy/supabase/migration.sql`（继续追加）

**Interfaces:**
- Consumes: Task 3 的 `profiles.resource_name`
- Produces:
  - `save_plan(p_project_id uuid, p_plan jsonb) returns jsonb` —— 协作者唯一写入口
  - `assert_plan_editable(p_old jsonb, p_new jsonb, p_rname text) returns void`
  - 辅助函数：`bar_norm` / `bars_norm` / `plan_tasks` / `is_go_ms` / `bar_owned` / `only_manual_changed`

- [ ] **Step 1: 追加辅助函数**

在 `deploy/supabase/migration.sql` 末尾追加：

```sql
-- ---------- 5.3 保存校验的辅助函数 ----------

-- 任务条的"业务内容"：剔除两个运行期字段
--   mod  —— collect() 写回，随需求改名而变；不剔除会让"改名"被误判成"批量修改任务"
--   isMs —— collect() 写回，由有无 m 键即可推出
create or replace function public.bar_norm(p_bar jsonb)
returns jsonb language sql immutable as $$
  select p_bar - 'mod' - 'isMs';
$$;

-- 需求 bars 的归一化数组（带序，保证比较稳定）
create or replace function public.bars_norm(p_mod jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(public.bar_norm(b) order by i), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_mod->'bars','[]'::jsonb)) with ordinality t(b, i);
$$;

-- 把 plan 展开成 (需求名, 需求归属, 任务键, 任务内容) 的行集。
-- 任务键：优先 bar.id；老数据的里程碑可能还没落 id，用 需求名||'#ms'||序号 兜底
create or replace function public.plan_tasks(p_plan jsonb)
returns table(mod text, mowner text, tkey text, bar jsonb)
language sql immutable as $$
  select m->>'name',
         m->>'owner',
         coalesce(b->>'id', (m->>'name') || '#ms' || i::text),
         public.bar_norm(b)
    from jsonb_array_elements(coalesce(p_plan->'modules','[]'::jsonb)) m,
         jsonb_array_elements(coalesce(m->'bars','[]'::jsonb)) with ordinality t(b, i);
$$;

-- 「上线」里程碑：口径与前端 core/versions.js:100 的 isGoMs 完全一致
create or replace function public.is_go_ms(p_bar jsonb)
returns boolean language sql immutable as $$
  select (p_bar ? 'm')
     and ((p_bar->>'p') = 'go' or coalesce(p_bar->>'label','') like '%上线%');
$$;

-- 任务归我：res 为空数组 = 未分配 = 待认领（谁都能改）；res 不存在 = 里程碑（不算归我）。
-- 没配人名的人不认任何任务（与前端 resolveAccess 把它降级为 readonly 一致）
create or replace function public.bar_owned(p_bar jsonb, p_rname text)
returns boolean language sql immutable as $$
  select case
    when p_rname is null or btrim(p_rname) = '' then false
    when not (p_bar ? 'res') then false
    when jsonb_array_length(p_bar->'res') = 0 then true
    else exists (select 1 from jsonb_array_elements_text(p_bar->'res') e where e = p_rname)
  end;
$$;

-- 除 manual 外其他内容都没变（用于"级联钉住"特许）
create or replace function public.only_manual_changed(p_old jsonb, p_new jsonb)
returns boolean language sql immutable as $$
  select (p_old - 'manual') = (p_new - 'manual');
$$;
```

- [ ] **Step 2: 验证辅助函数口径**

在 SQL Editor 执行：

```sql
-- 未分配任务 → 归任何人
select public.bar_owned('{"id":"a","res":[]}'::jsonb, '张三') as should_be_true;
-- 里程碑（无 res）→ 不归任何人
select public.bar_owned('{"m":"2026-09-09","label":"上线"}'::jsonb, '张三') as should_be_false;
-- 含我 / 不含我
select public.bar_owned('{"res":["张三","李四"]}'::jsonb, '张三') as t,
       public.bar_owned('{"res":["李四"]}'::jsonb, '张三') as f;
-- 上线里程碑识别（两种写法都要 true）
select public.is_go_ms('{"m":"2026-09-09","p":"go","label":"上线"}'::jsonb) as t1,
       public.is_go_ms('{"m":"2026-11-13","label":"11/13 整体上线"}'::jsonb) as t2,
       public.is_go_ms('{"m":"2026-09-16","p":"cfm","label":"需求确认"}'::jsonb) as f1;
-- 剔除运行期字段：只有 mod/isMs 不同 → 视为未变
select (public.bar_norm('{"id":"x","s":"2026-09-01","mod":"旧名","isMs":false}'::jsonb)
      = public.bar_norm('{"id":"x","s":"2026-09-01","mod":"新名","isMs":false}'::jsonb)) as should_be_true;
-- 只有 manual 变 → true；manual 之外还变了 → false
select public.only_manual_changed('{"manual":false,"s":"2026-09-01"}'::jsonb, '{"manual":true,"s":"2026-09-01"}'::jsonb) as t,
       public.only_manual_changed('{"manual":false,"s":"2026-09-01"}'::jsonb, '{"manual":true,"s":"2026-09-02"}'::jsonb) as f;
```

预期：注释里标 `should_be_*` 的列全部符合。

- [ ] **Step 3: 追加校验函数（上：需求、版本、特许集合）**

```sql
-- ---------- 5.4 协作者写盘的逐项校验 ----------
-- 规则与前端 src/utils/permission.js 逐条对应；改动必须两处同步。
-- 纯校验：只 raise、不写库，便于单独构造用例验证。
create or replace function public.assert_plan_editable(p_old jsonb, p_new jsonb, p_rname text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  r             record;
  v_ver_changed boolean;
  v_pin_ok      text[];
  v_moved       text[];
begin
  -- (1) 项目周期（start/end）刻意**不校验** —— 它是派生数据，不是用户动作。
  --   cycle.apply() 每次保存都按任务日期重算 start=min(s,m) / end=max(e,m) 并写回 state
  --   （src/scheduler/cycle.js:18-44；由 scheduler/index.js:88 的 ctx.save 调用，
  --    加载时 plan-sync.js:48 也会重算一次）。UI 里已无「周期」入口。
  --   若在这里要求 start/end 不可变，协作者改一次期就会被自己引发的派生写入拒掉 —— 功能直接不可用。
  --   残留风险（已接受）：协作者可伪造成假值，但下次加载即被任务日期覆盖，
  --   仅影响 hero 副标题的一行显示，无实质影响。

  -- (2) 资源库整体不可变
  if coalesce(p_old->'resources','[]'::jsonb) is distinct from coalesce(p_new->'resources','[]'::jsonb) then
    raise exception '无权修改资源库' using errcode = '42501';
  end if;

  -- (3) 需求不可删除、不可改名；两者都只要求归属权。
  --     改名识别依据（设计文档 §5.4）：new 里存在一个"新增"需求，其 bars（归一化后）
  --     与被删需求深度相等 —— 改名只动 name / bars[].mod / versions[].mods，不碰任务本身。
  --     识别不出来时按"删除"处理，错误信息也就能指对方向。
  for r in
    select o as mod
      from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o
     where not exists (
             select 1 from jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
              where (n->>'name') = (o->>'name'))
  loop
    if (r.mod->>'owner') is distinct from p_rname then
      if exists (
        select 1 from jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
         where public.bars_norm(n) = public.bars_norm(r.mod)
           and not exists (
             select 1 from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o2
              where (o2->>'name') = (n->>'name'))
      ) then
        raise exception '无权重命名需求「%」：该需求不是你创建的',
          coalesce(r.mod->>'name','?') using errcode = '42501';
      else
        raise exception '无权删除需求「%」：该需求不是你创建的',
          coalesce(r.mod->>'name','?') using errcode = '42501';
      end if;
    end if;
  end loop;

  -- (4) 需求的归属级字段（archived / owner）：只归需求创建人
  for r in
    select o as omod
      from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o
      join jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
        on (n->>'name') = (o->>'name')
     where (o->>'archived') is distinct from (n->>'archived')
        or (o->>'owner')    is distinct from (n->>'owner')
  loop
    if (r.omod->>'owner') is distinct from p_rname then
      raise exception '无权归档或转交需求「%」：该需求不是你创建的',
        coalesce(r.omod->>'name','?') using errcode = '42501';
    end if;
  end loop;

  -- (5) 版本不可删除（按 id 匹配）
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old->'versions','[]'::jsonb)) o
     where not exists (
             select 1 from jsonb_array_elements(coalesce(p_new->'versions','[]'::jsonb)) n
              where (n->>'id') = (o->>'id'))
  ) then
    raise exception '无权删除版本' using errcode = '42501';
  end if;

  -- (6) 特许集合：本次允许写「上线」里程碑的需求名（设计文档 §6.4 特许②③）
  v_ver_changed := coalesce(p_old->'versions','[]'::jsonb)
                   is distinct from coalesce(p_new->'versions','[]'::jsonb);

  select coalesce(array_agg(distinct nm), '{}'::text[]) into v_pin_ok
    from (
      -- 特许②：版本数据本次有变化 → 放行"新版本成员"的上线里程碑
      select m as nm
        from jsonb_array_elements(coalesce(p_new->'versions','[]'::jsonb)) v,
             jsonb_array_elements_text(coalesce(v->'mods','[]'::jsonb)) m
       where v_ver_changed
      union
      -- 特许③：本次由"待排期"转为"已排期" → 放行该需求的上线里程碑
      select n->>'name'
        from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o
        join jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
          on (n->>'name') = (o->>'name')
       where coalesce((o->>'unscheduled')::boolean, false)
         and not coalesce((n->>'unscheduled')::boolean, false)
    ) t;
```

- [ ] **Step 4: 追加校验函数（下：任务级 diff）—— 续上，仍属同一个函数体**

紧接 Step 3 的 SQL 之后追加（不要另起 `create function`）：

```sql

  -- (7) 我真正移动过的任务（有归属权 + s/e/m 有变化）→ 级联依据（设计文档 §6.3.1）
  select coalesce(array_agg(o.tkey), '{}'::text[]) into v_moved
    from public.plan_tasks(p_old) o
    join public.plan_tasks(p_new) n on n.tkey = o.tkey
   where o.bar <> n.bar
     and ((o.bar->>'s') is distinct from (n.bar->>'s')
       or (o.bar->>'e') is distinct from (n.bar->>'e')
       or (o.bar->>'m') is distinct from (n.bar->>'m'))
     and public.bar_owned(o.bar, p_rname);

  -- (8) 任务级 diff：新增 / 删除 / 修改三条规则
  for r in
    select o.tkey as okey, o.bar as obar, o.mod as omod, o.mowner as omowner,
           n.bar as nbar, n.mod as nmod
      from public.plan_tasks(p_old) o
      -- ⚠️ JOIN 必须**同时**比 tkey 与 mod。任务所属需求在数据里是"位置性"的
      --   （落在哪个 modules[].bars 里就是哪个需求的，mutations.js 的 moveBar 用 splice/push 实现），
      --   `plan_tasks` 的 tkey 只取 b.id、`bar_norm` 又剔掉了 mod —— 于是"纯跨需求移动"
      --   （只改 t.mod、其余字段不变）会满足 o.tkey = n.tkey 且 o.bar = n.bar，
      --   不进 diff 行集、三条分支一条都不走 → **静默放行**。
      --   后果是一条两步越权路径：① 把他人任务搬进我的需求（放行）→ ② 删我的需求（连带删除）。
      --   补上 mod 后，移动会退化成"从旧需求删除 + 向新需求新增"两行，各自走既有分支：
      --     移动他人任务 → 删除分支的 bar_owned=false 且例外不成立（omowner 不是我）→ REJECT
      --     移动自己的任务 → 删除/新增两侧都归我 → 放行（符合设计）
      --     需求改名 → 所有 bar 都换 mod，但删除侧被"我是需求创建人且该需求已消失"豁免、
      --              新增侧被"该需求是本次新建的"豁免 → 仍放行
      --   注意**不能**把 mod 编进 tkey：Step 7 的 v_moved 需要用"只按 id"的 join 认
      --   "被移动过的任务"，否则"先竖拖换需求、再级联"时 v_moved 为空、下游钉住会被误拒。
      full outer join public.plan_tasks(p_new) n on n.tkey = o.tkey and n.mod = o.mod
     where o.tkey is null or n.tkey is null or o.bar <> n.bar
  loop
    -- 新增
    if r.okey is null then
      if not (
        -- 整个需求是本次新建的（新需求自带的阶段任务与里程碑一起放行）
        not exists (select 1 from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) m
                     where (m->>'name') = r.nmod)
        or public.bar_owned(r.nbar, p_rname)
        or (public.is_go_ms(r.nbar) and r.nmod = any(v_pin_ok))
      ) then
        raise exception '无权在需求「%」下新增任务', coalesce(r.nmod,'?') using errcode = '42501';
      end if;
      continue;
    end if;

    -- 删除
    if r.nbar is null then
      if not public.bar_owned(r.obar, p_rname) then
        -- 例外（决策 §1.1-13「需求创建人有该需求所有权限」的必然结果）：
        --   整条需求是我创建的、且本次被删掉了 → 连带删除里面的他人任务**放行**。
        --   这不是漏拦：spec §13 明确写了兜底方式是"前端删除确认弹窗必须列出
        --   「将同时删除 N 条他人负责的任务」"，而不是服务端拦下来。
        --   判据用 old 的 mod 归属：plan_tasks 已经把 mowner 带出来了。
        --   滥用面：他不能"把别人的任务搬进自己的需求再删"——因为上面 (8) 的 JOIN 同时比了 mod，
        --     跨需求移动他人任务会落到删除分支且 omowner 不是我 → 在**第一次** save_plan 就被拒。
        --     所以他只可能删掉"别人主动排进他需求里"的任务（那是设计明确接受的后果，见 spec §13）。
        if not (
          r.omowner = p_rname
          and not exists (
            select 1 from jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) m
             where (m->>'name') = r.omod)
        ) then
          raise exception '无权删除他人负责的任务（id=%）',
            coalesce(r.obar->>'id','?') using errcode = '42501';
        end if;
      end if;
      continue;
    end if;

    -- 修改：归我的直接放行
    if public.bar_owned(r.obar, p_rname) then continue; end if;

    -- 里程碑：跟需求归属走；「上线」里程碑可由版本机制 / 待排期联动特许（§6.4）
    if r.obar ? 'm' then
      if public.is_go_ms(r.obar) and r.omod = any(v_pin_ok) then continue; end if;
      if (r.omowner is not null and r.omowner = p_rname) then continue; end if;
      raise exception '无权修改他人需求的里程碑（% / %）',
        coalesce(r.omod,'?'), coalesce(r.obar->>'label','?') using errcode = '42501';
    end if;

    -- 普通任务：仅允许"级联钉住" —— manual 由 false 改 true，且内容只变了 manual，
    -- 且该任务的直接前置里有"被我本次移动过"的任务（§6.4 特许①）
    if coalesce((r.obar->>'manual')::boolean, false) is false
       and coalesce((r.nbar->>'manual')::boolean, false) is true
       and public.only_manual_changed(r.obar, r.nbar)
       and exists (
         select 1 from jsonb_array_elements(coalesce(r.obar->'dep','[]'::jsonb)) d
          where (d->>'id') = any(v_moved)
       ) then
      continue;
    end if;

    raise exception '无权修改他人负责的任务（id=%）',
      coalesce(r.obar->>'id','?') using errcode = '42501';
  end loop;
end;
$$;
```

- [ ] **Step 5: 追加 `save_plan`**

```sql
-- ---------- 5.5 计划保存的唯一入口 ----------
-- 背景：RLS 的 projects_update 只放行 owner/admin（策略一字不改），
-- 协作者直接 PATCH projects 会被拒。协作者改自己任务的唯一通道就是本函数。
-- SECURITY DEFINER 绕过 RLS，但身份与规则由函数内部判定。
-- updated_at 由既有的 projects_touch_updated 触发器维护，这里不写。
create or replace function public.save_plan(p_project_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_old   jsonb;
  v_role  text;
  v_rname text;
begin
  if v_uid is null then
    raise exception '未登录，无法保存' using errcode = '42501';
  end if;

  select owner_id, plan into v_owner, v_old
    from public.projects where id = p_project_id;
  if not found then
    raise exception '项目不存在' using errcode = 'P0002';
  end if;

  select role, resource_name into v_role, v_rname
    from public.profiles where id = v_uid;

  -- 快路径：所属人 / 管理员整份替换（行为与改造前的直接 PATCH 完全一致）
  if coalesce(v_role, 'user') = 'admin' or v_owner = v_uid then
    update public.projects set plan = p_plan where id = p_project_id;
    return jsonb_build_object('ok', true);
  end if;

  -- 协作者：必须配了"对应人员"，否则一律拒绝（设计文档 §4.1 的安全口径）
  if v_rname is null or btrim(v_rname) = '' then
    raise exception '账号未指定对应人员，无法保存（请联系管理员）' using errcode = '42501';
  end if;

  perform public.assert_plan_editable(
    coalesce(v_old, '{}'::jsonb),
    coalesce(p_plan, '{}'::jsonb),
    btrim(v_rname)
  );

  update public.projects set plan = p_plan where id = p_project_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 只给登录用户可执行（游客本来就只读，不需要）
revoke all on function public.save_plan(uuid, jsonb) from public;
grant execute on function public.save_plan(uuid, jsonb) to authenticated;
```

- [ ] **Step 6: 用 MCP 应用迁移，并确认幂等**

用 `supabase_apply_migration`（名称建议 `user_permission_rbac_step2_save_plan`）应用 Step 1–5 的 SQL，
然后用 `supabase_execute_sql` **把同一段重跑一遍**确认幂等（`create or replace function` 天然幂等）。

> 若你没有这两个 MCP 工具：**立刻回报 NEEDS_CONTEXT**，由控制者代为应用并把真实输出交给你。

- [ ] **Step 7: 真跑 19 条校验用例（这一步不能跳）**

`assert_plan_editable` 是**纯校验函数**（`returns void`，只 `raise`、**不写任何库**），用 `jsonb_set` 造 diff 就能测，
不必真的调 RPC。**用 `supabase_execute_sql` 直接在生产库上跑**——它不写数据，所以安全。

> **刻意不用外层事务**：MCP **只返回本次调用最后一条语句**的结果（Task 3 已实测），
> `begin; … rollback;` 会把探针结果盖掉。所以改成"辅助函数顺带把结果写进临时表 + 最后一条 `select` 带回来"，
> 辅助函数在**另一次调用**里单独 `drop`。

```sql
create temp table if not exists t_cases(seq serial, result text);
truncate t_cases restart identity;

-- 测试辅助：返回 PASS 或 REJECT: 原因，**并顺带把结果按调用顺序写进 t_cases**。
-- 为什么要有这个副作用：MCP 不返回 raise notice，只有本次调用最后一条语句的结果能带回来；
-- 把它做成 t_try 的副作用，下面的用例行就一行都不用改（每行仍恰好调用 t_try 一次）。
create or replace function public.t_try(p_old jsonb, p_new jsonb, p_rname text)
returns text language plpgsql as $$
declare r text;
begin
  begin
    perform public.assert_plan_editable(p_old, p_new, p_rname);
    r := 'PASS';
  exception when others then
    r := 'REJECT: ' || sqlerrm;
  end;
  insert into t_cases(result) values (r);
  return r;
end; $$;

do $$
declare
  b jsonb := '{
    "start":"2026-08-12","end":"2026-10-31",
    "resources":[{"id":"zhangsan","name":"张三"}],
    "versions":[{"id":"v1","name":"9月版","date":"2026-09-30","shipped":false,"mods":[]}],
    "modules":[
      {"name":"登录改版","owner":"张三","bars":[
        {"id":"A","s":"2026-09-01","e":"2026-09-01","w":1,"res":["张三"],"dep":[],"manual":false},
        {"id":"B","s":"2026-09-02","e":"2026-09-02","w":1,"res":["李四"],"dep":[{"id":"A","lag":0}],"manual":false}
      ]},
      {"name":"他人需求","owner":"李四","bars":[
        {"id":"C","s":"2026-09-03","e":"2026-09-03","w":1,"res":["李四"],"dep":[],"manual":false},
        {"id":"C-go","m":"2026-09-30","p":"go","label":"上线","manual":true,"dep":[]},
        {"id":"D","s":"2026-09-04","e":"2026-09-04","w":1,"res":[],"dep":[],"manual":false}
      ]}
    ]}'::jsonb;
  n jsonb;
begin
  -- 1 改自己任务 A 的日期 → PASS
  n := jsonb_set(b, '{modules,0,bars,0,s}', '"2026-09-10"');
  raise notice '1  改自己任务           → %', public.t_try(b, n, '张三');

  -- 2 改他人任务 C 的日期 → REJECT
  n := jsonb_set(b, '{modules,1,bars,0,s}', '"2026-09-10"');
  raise notice '2  改他人任务           → %', public.t_try(b, n, '张三');

  -- 3 删他人任务 C → REJECT
  n := jsonb_set(b, '{modules,1,bars}', (b->'modules'->1->'bars') - 0);
  raise notice '3  删他人任务           → %', public.t_try(b, n, '张三');

  -- 4 钉住 B（A 同时被移动）→ PASS（特许①）
  n := jsonb_set(jsonb_set(b, '{modules,0,bars,0,s}', '"2026-09-10"'), '{modules,0,bars,1,manual}', 'true');
  raise notice '4  级联钉住(有依据)     → %', public.t_try(b, n, '张三');

  -- 5 钉住 B（A 没动）→ REJECT（凭空锁别人的任务）
  n := jsonb_set(b, '{modules,0,bars,1,manual}', 'true');
  raise notice '5  级联钉住(无依据)     → %', public.t_try(b, n, '张三');

  -- 6 改未分配任务 D → PASS（待认领）
  n := jsonb_set(b, '{modules,1,bars,2,s}', '"2026-09-10"');
  raise notice '6  改未分配任务         → %', public.t_try(b, n, '张三');

  -- 7 删自己创建的需求 → PASS
  n := jsonb_set(b, '{modules}', (b->'modules') - 0);
  raise notice '7  删自己的需求         → %', public.t_try(b, n, '张三');

  -- 8 删他人创建的需求 → REJECT
  n := jsonb_set(b, '{modules}', (b->'modules') - 1);
  raise notice '8  删他人需求           → %', public.t_try(b, n, '张三');

  -- 9 改自己需求的名字（bars 不变 → 识别为改名）→ PASS
  n := jsonb_set(b, '{modules,0,name}', '"登录改版V2"');
  raise notice '9  改自己需求名         → %', public.t_try(b, n, '张三');

  -- 10 改他人需求的名字 → REJECT
  n := jsonb_set(b, '{modules,1,name}', '"他人需求V2"');
  raise notice '10 改他人需求名         → %', public.t_try(b, n, '张三');

  -- 11 归档他人需求 → REJECT
  n := jsonb_set(b, '{modules,1,archived}', 'true');
  raise notice '11 归档他人需求         → %', public.t_try(b, n, '张三');

  -- 12 改**他人**需求字段（modules,1 是「他人需求」，owner=李四）→ PASS（字段级人人可改）
  --    注意必须打在 modules,1 上：打在 modules,0 是"改自己的需求"，证明不了"字段级对他人也放开"
  n := jsonb_set(b, '{modules,1,pri}', '"P0"');
  raise notice '12 改他人需求字段       → %', public.t_try(b, n, '张三');

  -- 13 改资源库 → REJECT
  n := jsonb_set(b, '{resources}', '[]');
  raise notice '13 改资源库             → %', public.t_try(b, n, '张三');

  -- 14 伪造项目周期 → PASS（start/end 是派生数据，服务端刻意不校验，见函数内注释）
  n := jsonb_set(b, '{end}', '"2026-11-30"');
  raise notice '14 伪造项目周期         → %', public.t_try(b, n, '张三');

  -- 15 删版本 → REJECT
  n := jsonb_set(b, '{versions}', '[]');
  raise notice '15 删版本               → %', public.t_try(b, n, '张三');

  -- 16 版本变化下改他人需求的「上线」里程碑 → PASS（特许②）
  n := jsonb_set(jsonb_set(b, '{versions,0,mods}', '["他人需求"]'), '{modules,1,bars,1,m}', '"2026-10-15"');
  raise notice '16 版本机制改上线里程碑 → %', public.t_try(b, n, '张三');

  -- 17 无版本变化下改他人需求的「上线」里程碑 → REJECT
  n := jsonb_set(b, '{modules,1,bars,1,m}', '"2026-10-20"');
  raise notice '17 手改他人上线里程碑   → %', public.t_try(b, n, '张三');

  -- 18 纯跨需求移动：把**他人**任务 C 从「他人需求」移到「登录改版」→ REJECT
  --    这条是 2026-10-15 评审发现 I-1 后补的：原 17 条**没有一条**覆盖"改 t.mod"，
  --    而 tkey 不含 mod 时这种移动完全不进 diff → 放行，并构成"搬进我的需求→删我的需求"的两步越权删除
  n := jsonb_set(
         jsonb_set(b, '{modules,1,bars}', (b->'modules'->1->'bars') - 0),
         '{modules,0,bars}', (b->'modules'->0->'bars') || jsonb_build_array(b->'modules'->1->'bars'->0)
       );
  raise notice '18 跨需求移动他人任务   → %', public.t_try(b, n, '张三');

  -- 19 纯跨需求移动：把**自己**任务 A 从「登录改版」移到「他人需求」→ PASS
  --    证明 18 的拦截不是"把移动一律打死"：移动自己的任务两侧都归我，应当放行
  n := jsonb_set(
         jsonb_set(b, '{modules,0,bars}', (b->'modules'->0->'bars') - 0),
         '{modules,1,bars}', (b->'modules'->1->'bars') || jsonb_build_array(b->'modules'->0->'bars'->0)
       );
  raise notice '19 跨需求移动自己任务   → %', public.t_try(b, n, '张三');
end $$;

-- 最后一条语句：把 19 条结果按调用顺序带回来（顺序即下方用例的编号顺序）
select c.seq, v.label, c.result
  from t_cases c
  join (values
    (1,'1  改自己任务'),(2,'2  改他人任务'),(3,'3  删他人任务'),
    (4,'4  级联钉住(有依据)'),(5,'5  级联钉住(无依据)'),(6,'6  改未分配任务'),
    (7,'7  删自己的需求'),(8,'8  删他人需求'),(9,'9  改自己需求名'),
    (10,'10 改他人需求名'),(11,'11 归档他人需求'),(12,'12 改他人需求字段'),
    (13,'13 改资源库'),(14,'14 伪造项目周期'),(15,'15 删版本'),
    (16,'16 版本机制改上线里程碑'),(17,'17 手改他人上线里程碑'),
    (18,'18 跨需求移动他人任务'),(19,'19 跨需求移动自己任务')
  ) v(seq, label) on v.seq = c.seq
 order by c.seq;
```

**执行完再单独发起一次调用清理辅助函数**（不能放在同一次调用的末尾，否则会盖掉结果）：

```sql
drop function if exists public.t_try(jsonb, jsonb, text);
```

预期（逐行对照，**任何一条不符都说明规则实现错了**）：

| # | 用例 | 期望 |
|---|---|---|
| 1 | 改自己任务 | PASS |
| 2 | 改他人任务 | REJECT |
| 3 | 删他人任务 | REJECT |
| 4 | 级联钉住（有依据） | PASS |
| 5 | 级联钉住（无依据） | REJECT |
| 6 | 改未分配任务 | PASS |
| 7 | 删自己的需求 | PASS |
| 8 | 删他人需求 | REJECT |
| 9 | 改自己需求名 | PASS |
| 10 | 改他人需求名 | REJECT |
| 11 | 归档他人需求 | REJECT |
| 12 | 改他人需求字段 | PASS |
| 13 | 改资源库 | REJECT |
| 14 | 伪造项目周期 | **PASS**（`start`/`end` 是 `cycle.apply()` 每次保存都重算的派生数据，不校验；这是刻意的，不要"修"成 REJECT——那会让协作者所有改期都被拒） |
| 15 | 删版本 | REJECT |
| 16 | 版本机制改上线里程碑 | PASS |
| 17 | 手改他人上线里程碑 | REJECT |
| 18 | **跨需求移动他人任务** | **REJECT**（评审 I-1 后补：tkey 不含 `mod` 时这条会被静默放行，并构成"搬进我的需求→删我的需求"的两步越权删除） |
| 19 | 跨需求移动自己的任务 | **PASS**（证明 18 不是"把移动一律打死"） |

- [ ] **Step 7b: 端到端冒烟 `save_plan` 本身（不只是校验函数）**

上面 17 条测的是**规则**（`assert_plan_editable` 是纯函数、只 `raise`）；而 RPC 的**身份分流**没被覆盖。
按 Phase 2 的手法跑（结论写进变量 → 故意 `raise` 撤销写入 → 最后一条 `select` 带回来）：

```sql
create temp table if not exists t_rpc(label text, result text);
truncate t_rpc;
do $rpc$
declare
  msg   text;
  c_li  uuid := 'f65c4375-0c6f-49aa-81b5-4ea5cf4a8acb';   -- 李功林：所属人 + 管理员
  c_xin uuid := 'c6ff5485-65cc-4b90-85a1-1b3d4f7df70f';   -- 徐新：普通用户，resource_name 为空
  v_pid  uuid;
  v_plan jsonb;
begin
  select id, plan into v_pid, v_plan from public.projects limit 1;

  -- ① 所属人 → 快路径整份替换（内容与库中相同，等价空操作）
  perform set_config('request.jwt.claims', json_build_object('sub', c_li)::text, false);
  begin
    perform public.save_plan(v_pid, v_plan);
    msg := 'PASS(放行)';
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if msg is null then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end if;
  end;
  insert into t_rpc values ('① 所属人 save_plan 快路径', msg);

  -- ② 已登录但未配「对应人员」→ 应被拒（这是最容易漏配、也最难排查的路径）
  msg := null;
  perform set_config('request.jwt.claims', json_build_object('sub', c_xin)::text, false);
  begin
    perform public.save_plan(v_pid, v_plan);
    msg := 'PASS(放行) <-- 不该发生！';
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if msg is null then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end if;
  end;
  insert into t_rpc values ('② 未配对应人员的用户', msg);

  -- ③ 未登录 → 应被拒
  msg := null;
  perform set_config('request.jwt.claims', '', false);
  begin
    perform public.save_plan(v_pid, v_plan);
    msg := 'PASS(放行) <-- 不该发生！';
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if msg is null then msg := 'REJECT: ' || sqlstate || ' / ' || sqlerrm; end if;
  end;
  insert into t_rpc values ('③ 未登录', msg);
end $rpc$;
select label, result from t_rpc order by label;
```

预期：

| 用例 | 期望 |
|---|---|
| ① 所属人快路径 | `PASS(放行)` |
| ② 已登录但未配「对应人员」 | `REJECT: 42501 / 账号未指定对应人员，无法保存（请联系管理员）` |
| ③ 未登录 | `REJECT: 42501 / 未登录，无法保存` |

**同时确认项目 plan 未被本次冒烟改动**（`select updated_at, md5(plan::text) from public.projects;` 与跑之前一致）。

- [ ] **Step 8: 提交**

```bash
git add deploy/supabase/migration.sql
git commit -m "feat(权限): 新增 save_plan RPC 与 assert_plan_editable 服务端校验"
```

---

### Task 5: `list_resource_names` RPC

**Files:**
- Modify: `deploy/supabase/migration.sql`（继续追加）

**Interfaces:**
- Consumes: 各项目 `projects.plan` 里的 `resources[].name` 与任务 `res[]`
- Produces: `list_resource_names() returns table(name text)` —— 供"对应人员"的 `datalist` 候选

- [ ] **Step 1: 追加 SQL**

```sql
-- ---------- 5.6 资源库人名候选 ----------
-- 用途：用户管理页"对应人员"输入框的 datalist 候选（Task 16）。
-- 为什么必须给候选：resource_name 拼错的人会"什么都改不了"，而且从界面上完全看不出
-- 是拼错了还是没配 —— 这是本次最难排查的故障形态。
-- 来源：各项目 plan 里资源库的 name + 任务 res 里出现过的名字（含资源库外的孤儿名）。
create or replace function public.list_resource_names()
returns table(name text)
language sql
security definer set search_path = public
stable
as $$
  -- distinct **btrim**：候选必须归一化去重。
  --   理由不是"好看"，而是 updateProfile（Task 13）对 resource_name 一律 .trim() 后才入库，
  --   所以 '  张三  ' 这种候选**永远不可能以原样落库**（选它、存进去就成 '张三'），
  --   留着它只会让管理员以为存在一个叫"张三 "的人。
  --   注意：这**不修**既有数据问题——若某任务的 res 里本来就带空格，它仍然匹配不上（bar_owned 是精确相等）。
  select distinct btrim(nm) as nm
    from (
      -- 资源库里的人
      select r->>'name' as nm
        from public.projects p,
             jsonb_array_elements(coalesce(p.plan->'resources','[]'::jsonb)) r
      union
      -- 任务 res 里出现过的名字（含已从资源库删掉、但任务上还留着的孤儿名）
      select e as nm
        from public.projects p,
             jsonb_array_elements(coalesce(p.plan->'modules','[]'::jsonb)) m,
             jsonb_array_elements(coalesce(m->'bars','[]'::jsonb)) b,
             jsonb_array_elements_text(coalesce(b->>'res','[]')::jsonb) e
    ) t
   where nm is not null and btrim(nm) <> ''
   order by nm;
$$;

-- 所有登录用户都要读（项目列表页的管理员面板用它；非管理员拿到的候选也无害）
grant execute on function public.list_resource_names() to authenticated;
```

- [ ] **Step 2: 用 MCP 应用并真跑验证**

应用：`supabase_apply_migration`（名称建议 `user_permission_rbac_step3_list_resource_names`）。
验证：`supabase_execute_sql` 执行

```sql
select * from public.list_resource_names();
```

**预期**：返回去重后的人名列表，不含空串、无重复。
对当前真实库（只有 1 个项目），结果就是那个项目 `plan` 里 `resources[].name` 与任务 `res` 中出现过的名字集合。
**把实际输出原样写进报告**——不要照抄默认数据的「张三」「李四」（真实库的项目内容不一定与默认数据相同）。

顺带确认它不会因为空/畸形 plan 而报错：
```sql
select count(*) from public.list_resource_names() where name is null or btrim(name) = '';
```
预期：`0`。

- [ ] **Step 3: 提交**

```bash
git add deploy/supabase/migration.sql
git commit -m "feat(权限): 新增 list_resource_names RPC 作为对应人员的候选来源"
```

---

### Task 6: 前端保存改走 RPC + 权限拒绝时回滚

**Files:**
- Modify: `src/services/backends/supabase.js:144-151`（`savePlan`）
- Modify: `src/services/projects.js:29-33`（`errMsg`）+ 导出 `isDenied`
- Modify: `src/services/plan-sync.js:90-108`（`pushToServer`）+ 新增 `rollbackFromServer`
- Test: `tests/services.test.js`

**Interfaces:**
- Consumes: Task 4 的 `save_plan(p_project_id, p_plan)`
- Produces:
  - `projects.isDenied(error) => boolean` —— 判定"服务端校验拒绝"
  - `plan-sync.pushToServer()` 在拒绝时**回滚**并提示服务端具体原因

- [ ] **Step 1: 写失败测试**

在 `tests/services.test.js` 里，先把顶部的 mock 定义改为含 `isDenied`：

```js
// mock projects 服务（避免触碰真实 supabase client）
const mocks = vi.hoisted(() => ({
  loadPlan: vi.fn(),
  savePlan: vi.fn(),
  errMsg: vi.fn(e => e && e.message || ''),
  isDenied: vi.fn(() => false)
}));
vi.mock('../src/services/projects.js', () => mocks);
```

在文件末尾追加：

```js
describe('plan-sync: 服务端权限拒绝 → 回滚', () => {
  beforeEach(() => {
    planStore.reset();
    userStore.reset();
    mocks.loadPlan.mockReset();
    mocks.savePlan.mockReset();
    mocks.isDenied.mockReset();
    mocks.isDenied.mockReturnValue(false);
    mocks.errMsg.mockReset();
    mocks.errMsg.mockImplementation(e => (e && e.message) || '');
  });

  it('被拒时用服务器版本覆盖本地（回滚），并透出服务端的具体原因', async () => {
    userStore.set({ projectId: 'p1' });
    planStore.set({ modules: [{ name: '本地乱改的', bars: [] }], resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务（id=x）' } });
    mocks.isDenied.mockReturnValue(true);
    mocks.loadPlan.mockResolvedValue({
      data: { plan: { modules: [{ name: '服务器版本', bars: [] }], resources: [], versions: [] } },
      error: null
    });

    const { sync, onSyncStatus } = makeDeps();
    const ok = await sync.pushToServer();

    expect(ok).toBe(false);
    expect(onSyncStatus).toHaveBeenCalledWith('fail', {
      msg: expect.stringContaining('无权修改他人负责的任务（id=x）')
    });
    // 回滚是异步的，等一个 tick
    await new Promise(r => setTimeout(r, 0));
    expect(mocks.loadPlan).toHaveBeenCalledWith('p1');
    expect(planStore.state.modules[0].name).toBe('服务器版本');
  });

  it('非权限类失败不回滚（网络抖动不该丢掉本地改动）', async () => {
    userStore.set({ projectId: 'p1' });
    planStore.set({ modules: [{ name: '本地改动', bars: [] }], resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '57014', message: '超时' } });
    mocks.isDenied.mockReturnValue(false);

    const { sync } = makeDeps();
    await sync.pushToServer();
    await new Promise(r => setTimeout(r, 0));

    expect(mocks.loadPlan).not.toHaveBeenCalled();
    expect(planStore.state.modules[0].name).toBe('本地改动');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/services.test.js -t "权限拒绝"`
Expected: FAIL —— `mocks.isDenied is not a function` 或回滚未发生

- [ ] **Step 3: `savePlan` 改走 RPC**

`src/services/backends/supabase.js`，把 `savePlan` 整个方法（现 `:144-151`）替换为：

```js
  async savePlan(projectId, plan) {
    const miss = needClient();
    if (miss) return miss;
    // 唯一写入口：走 RPC，由服务端做身份判定与细粒度校验（migration.sql 的 save_plan）。
    // 不再直接 PATCH projects —— RLS 的 projects_update 只放行 owner/admin，
    // 协作者直接 PATCH 会被拒；RPC 是 SECURITY DEFINER，把规则判定收回服务端。
    return getClient().rpc('save_plan', { p_project_id: projectId, p_plan: plan });
  },
```

- [ ] **Step 4: `errMsg` 透出具体原因，新增 `isDenied`**

`src/services/projects.js`，把 `errMsg` 替换为：

```js
// 服务端校验拒绝的判定（设计文档 §6.2）：
//   PostgREST 把 plpgsql 的 raise ... using errcode 原样带出（code = '42501'）
export function isDenied(error) {
  if (!error) return false;
  if (error.code === '42501') return true;
  return /无权|未指定对应人员|仅管理员/.test(String(error.message || ''));
}

// 错误文案：权限拒绝必须原样透出服务端的中文原因。
// 改造前这里把 42501 统一压成「无权限修改该项目」—— 那是行级策略时代的文案，
// 现在服务端会告诉我们"到底哪一条规则被触发"，笼统化会让用户不知道该怎么办。
export function errMsg(error) {
  if (!error) return '';
  if (error.code === '42501') return error.message || '无权限执行该操作';
  return error.message || '操作失败';
}
```

并把默认导出的对象加上 `isDenied`：

```js
export default {
  listUsers, listUserOptions, setAdmin,
  listProjects, getProject, createProject, updateProject, deleteProject,
  loadPlan, savePlan, errMsg, isDenied
};
```

- [ ] **Step 5: `pushToServer` 加回滚**

`src/services/plan-sync.js`：

① 顶部 import 追加 `isDenied`：

```js
import { loadPlan, savePlan, errMsg, isDenied } from './projects.js';
```

② 在 `pushToServer` 之前插入 `rollbackFromServer`：

```js
  // 权限拒绝后的回滚：拉回服务器版本覆盖本地。
  // 刻意不复用 loadFromServer()：后者会 resetHistory/recordInitial，
  // 那会把"改坏了"的本地快照一起洗掉，用户就没法用撤销退回去了。
  // 走 planStore.set 而不是 ctx.save()，因此不会再触发一次 pushToServer（不会死循环）。
  function rollbackFromServer() {
    const projectId = userStore.state.projectId;
    if (!projectId) return;
    loadPlan(projectId)
      .then(({ data, error }) => {
        if (error || !data) return;
        const plan = data.plan || data;
        if (!Array.isArray(plan.modules)) return;
        planStore.set({
          modules: plan.modules,
          resources: Array.isArray(plan.resources) && plan.resources.length ? plan.resources : planStore.state.resources,
          versions: Array.isArray(plan.versions) ? plan.versions : []
        });
        if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
        if (schedRef && typeof schedRef.applyCycle === 'function') schedRef.applyCycle();
      })
      .catch(() => { /* 回滚都失败就只能等下次刷新，不额外报错打扰 */ });
  }
```

③ 把 `pushToServer` 的 `.then(({ error }) => {...})` 分支替换为：

```js
      .then(({ error }) => {
        if (error) {
          // 服务端校验拒绝是"乐观更新"架构下的常态路径：本地已经改过了、服务端不接受。
          // 必须回滚，否则界面显示的状态与库里不一致，用户会以为改成功了。
          if (isDenied(error)) {
            notifySync('fail', { msg: errMsg(error) + '（已回滚到服务器版本，你的改动未保存）' });
            rollbackFromServer();
            return false;
          }
          notifySync('fail', { msg: errMsg(error) });
          return false;
        }
        notifySync('ok', { savedBy: payload.savedBy, savedAt: payload.savedAt });
        return true;
      })
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/services.test.js`
Expected: PASS（含新增 2 条）

- [ ] **Step 7: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/services/backends/supabase.js src/services/projects.js src/services/plan-sync.js tests/services.test.js
git commit -m "feat(权限): 保存改走 save_plan RPC，权限拒绝时回滚并透出服务端具体原因"
```

---

## Phase 3 — 守卫就位（先于放权，零行为变化）

> 本阶段结束时系统行为与改造前**完全一致**：因为 `access` 还没被真实计算，
> `permission.ctxOf()` 对"非只读"状态一律返回 `full`。真正的放权在 Task 9。

### Task 7: `assertEditable(throwing, target)` 按粒度守卫

**Files:**
- Modify: `src/scheduler/mutations.js:17-22`（`assertEditable`）
- Modify: `src/scheduler/mutations.js` 全部调用点（按下方映射表逐个传 target）
- Modify: `src/scheduler/planning.js:151,160,175,186,195`
- Modify: `src/scheduler/persistence.js:84,99`
- Modify: `src/scheduler/index.js:95-104`（`undo`/`redo` 补守卫）
- Test: `tests/scheduler.test.js`

**Interfaces:**
- Consumes: Task 1 的 `permission.js`
- Produces:
  - `assertEditable(throwing, target) => boolean` —— 不带 `target` 时**最严**（等价 `canPlan`）
  - `permCtx() => { access, rname, role }`（从 `userStore.state` 派生，module 内私有）

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.js` 末尾追加：

```js
describe('scheduler: 按目标粒度的守卫', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  // 造一个"协作者"上下文：access 显式设成 collab，人名张三
  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
  const asFull = () => userStore.set({ readonly: false, access: 'full', resourceName: '张三' });

  it('协作者不能改别人负责的任务（静默不生效 + 可 throw 语义）', () => {
    const sched = makeSched();
    asCollab();
    // m1-sit 的 res 是 ["吴十"]，不归张三
    sched.saveTask('m1-sit', { name: '偷改' });
    expect(sched.getTask('m1-sit').name).not.toBe('偷改');
  });

  it('协作者能改自己负责的任务', () => {
    const sched = makeSched();
    asCollab();
    // m1-req 的 res 是 ["张三"]
    sched.saveTask('m1-req', { name: '我的任务' });
    expect(sched.getTask('m1-req').name).toBe('我的任务');
  });

  it('协作者能改未分配的任务（res 为空数组）', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: [] });
    const t = sched.tasks().filter(x => !x.isMs && (x.res || []).length === 0).pop();
    sched.saveTask(t.id, { name: '待认领的活' });
    expect(sched.getTask(t.id).name).toBe('待认领的活');
  });

  it('协作者不能动资源库', () => {
    const sched = makeSched();
    asCollab();
    const before = planStore.state.resources.length;
    sched.addResource({ name: '新人' });
    expect(planStore.state.resources.length).toBe(before);
  });

  it('协作者不能动里程碑（含自己需求里的：因为需求 owner 不是他）', () => {
    const sched = makeSched();
    asCollab();
    // 默认数据的「官网改版」没有 owner 字段 = 无主 → 协作者对它没有归属权
    const ms = sched.getTask('m1-cfm');
    expect(ms).toBeTruthy();
    sched.moveMilestone('m1-cfm', '2026-10-01');
    expect(sched.getTask('m1-cfm').m).not.toBe('2026-10-01');
  });

  // ⚠️ 这里刻意分成"无主"与"自己的"两条，因为它们的**权限结论相反**。
  //   决策 §1.1-13 是「需求创建人有该需求所有权限（改名/删除/归档/转交）」，
  //   所以归属人可以给自己需求改名/归档；无主需求才轮不到协作者。
  //   （初版这里写成"协作者不能给自己需求改名/归档"，与设计直接冲突，属计划缺陷，2026-10-23 修正。）
  it('协作者对**无主需求**不能改名（归档已由下一条覆盖）', () => {
    const sched = makeSched();
    asCollab();
    // 默认数据的「官网改版」没有 owner 字段 = 无主 → 协作者对它没有归属权
    expect(() => sched.updateModule({ name: '官网改版', oldName: '官网改版', name: '改名' })).toThrow();
    expect(planStore.state.modules.some(m => m.name === '官网改版')).toBe(true);   // 没被改掉
  });

  it('协作者能改**自己的需求**的字段，也能改名 / 归档（需求创建人全权）', () => {
    const sched = makeSched();
    asCollab();
    sched.addModule({ name: '我的需求', autoCreate: false });   // owner = 张三
    // 字段级
    sched.updateModule({ name: '我的需求', pri: 'P0' });
    expect(planStore.state.modules.find(m => m.name === '我的需求').pri).toBe('P0');
    // 归属级：改名（需求创建人有权）
    sched.updateModule({ oldName: '我的需求', name: '我的需求V2' });
    expect(planStore.state.modules.some(m => m.name === '我的需求V2')).toBe(true);
    // 归属级：归档（同上）
    sched.archiveModule('我的需求V2', true);
    expect(!!planStore.state.modules.find(m => m.name === '我的需求V2').archived).toBe(true);
  });

  it('协作者能改无主需求的字段，但不能归档它', () => {
    const sched = makeSched();
    asCollab();
    sched.updateModule({ name: '官网改版', pri: 'P0' });
    expect(planStore.state.modules.find(m => m.name === '官网改版').pri).toBe('P0');
    sched.archiveModule('官网改版', true);
    expect(!!planStore.state.modules.find(m => m.name === '官网改版').archived).toBe(false);
  });

  it('协作者不能动版本删除与一键归档，但能改版本', () => {
    const sched = makeSched();
    asCollab();
    const v = sched.createVersion({ name: '9月版', date: '2026-09-30' });
    const vid = v.version.id;
    sched.shipVersion(vid, true, '2026-09-30');
    expect(planStore.state.versions.find(x => x.id === vid).shipped).toBe(true);
    sched.deleteVersion(vid);
    expect(planStore.state.versions.some(x => x.id === vid)).toBe(true);   // 没被删掉
  });

  it('协作者不能一键自动计划 / 撤销 / 导入', () => {
    const sched = makeSched();
    asCollab();
    const before = JSON.stringify(planStore.state.modules);
    sched.computeSchedule();
    expect(JSON.stringify(planStore.state.modules)).toBe(before);
  });

  it('全权用户不受影响（回归）', () => {
    const sched = makeSched();
    asFull();
    sched.saveTask('m1-sit', { name: '我能改' });
    expect(sched.getTask('m1-sit').name).toBe('我能改');
    sched.addResource({ name: '新人' });
    expect(planStore.state.resources.some(r => r.name === '新人')).toBe(true);
  });

  it('只读模式仍然全拦（回归）', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(() => sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1 })).toThrow('只读模式');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.js -t "按目标粒度"`
Expected: FAIL（协作者改别人任务会成功、资源库会被改）

- [ ] **Step 3: 改 `assertEditable` 并加 `permCtx`**

`src/scheduler/mutations.js`，import 追加：

```js
import { ctxOf, canPlan, canTouchTask, canEditTask, canManageModule, canEditModuleFields,
         canEditVersion, canDeleteVersion, canArchiveVersionMods, canEditResources } from '../utils/permission.js';
```

把 `assertEditable`（现 `:17-22`）替换为：

```js
// 判定上下文：从 userStore.state 派生（access / rname / role）
function permCtx() { return ctxOf(userStore.state); }

// 按目标粒度的守卫（设计文档 §8.3）。
//   throw 语义用于"新增"类（UI 会因此弹错）；其余静默 return，与改造前一致。
//   不带 target 时取最严（等价 canPlan = 仅全权用户）。
//   target 形态：
//     { kind:'task',      task }                 普通任务（按 res 判定）
//     { kind:'milestone', ms, mo }               里程碑（按需求归属判定）
//     { kind:'taskNew',   mod, res }             新增任务（看它打算派给谁）
//     { kind:'moduleFields' }                    需求字段级
//     { kind:'module',    mo }                   需求归属级（改名/删除/归档/转交）
//     { kind:'moduleNew' }                       新增需求
//     { kind:'version' } / { kind:'versionDelete' } / { kind:'versionArchive' }
//     { kind:'resources' } / { kind:'plan' }
export function assertEditable(throwing, target) {
  const c = permCtx();
  let ok;
  switch (target && target.kind) {
    case 'task':          ok = canEditTask(target.task, c); break;
    case 'milestone':     ok = canTouchTask(target.ms, target.mo, c); break;
    case 'taskNew':       ok = canEditTask({ res: target.res }, c); break;
    case 'moduleFields':  ok = canEditModuleFields(c); break;
    case 'module':        ok = canManageModule(target.mo, c); break;
    case 'moduleNew':     ok = canEditModuleFields(c); break;
    case 'version':       ok = canEditVersion(c); break;
    case 'versionDelete': ok = canDeleteVersion(c); break;
    case 'versionArchive':ok = canArchiveVersionMods(c); break;
    case 'resources':     ok = canEditResources(c); break;
    case 'plan':
    default:              ok = canPlan(c);
  }
  if (ok) return true;
  if (throwing) throw new Error('只读模式，无法修改');
  return false;
}

// 给测试与调用方用的导出（保持既有只读语义的回归用例可读）
export { permCtx };
```

- [ ] **Step 4: 按映射表逐个调用点传 target**

逐个替换 `src/scheduler/mutations.js` / `planning.js` / `persistence.js` 里的 `assertEditable(...)` 调用。映射表：

| 文件:方法 | 现调用 | 改为 |
|---|---|---|
| `mutations.js` `saveTask(taskId, draft)` | `assertEditable()` | 见下方专项说明 |
| `mutations.js` `moveMilestone` / `setMilestoneDate` / `changeTaskType` | `assertEditable()` | `assertEditable(false, { kind:'milestone', ms: raw, mo: findMod(raw) })` |
| `mutations.js` `renameTask` / `deleteTask` | `assertEditable()` | `assertEditable(false, { kind:'task', task: raw })` |
| `mutations.js` `addTask(opts)` | `assertEditable(true)` | `assertEditable(true, { kind:'taskNew', res: opts.res })` |
| `mutations.js` `addModule(opts)` | `assertEditable(true)` | `assertEditable(true, { kind:'moduleNew' })` |
| `mutations.js` `updateModule(opts)` | `assertEditable()` | 见下方专项说明 |
| `mutations.js` `archiveModule(name, archived)` | `assertEditable()` | `assertEditable(false, { kind:'module', mo })` |
| `mutations.js` `deleteModule(name)` | `assertEditable()` | `assertEditable(false, { kind:'module', mo })` |
| `mutations.js` `moveModule` / `moveBar` | `assertEditable()` | `assertEditable(false, { kind:'moduleFields' })` |
| `mutations.js` `resizeTask(taskId, ...)` | `assertEditable()` | `assertEditable(false, { kind:'task', task })` |
| `mutations.js` `createVersion` / `updateVersion` / `shipVersion` / `removeModFromVersion` / `setModuleVersion` | `assertEditable(...)` | `assertEditable(true, { kind:'version' })`（`createVersion` 保留 throw） |
| `mutations.js` `deleteVersion` | `assertEditable()` | `assertEditable(false, { kind:'versionDelete' })` |
| `mutations.js` `archiveVersionMods` | `assertEditable()` | `assertEditable(false, { kind:'versionArchive' })` |
| `mutations.js` `updateResource` / `addResource` / `deleteResource` | `assertEditable(...)` | `assertEditable(false, { kind:'resources' })` |
| `planning.js` `computeSchedule` | `assertEditable()` | `assertEditable(false, { kind:'plan' })` |
| `planning.js` `cascade(anchorId, ...)` | `assertEditable()` | `assertEditable(false, { kind:'task', task: ctx.getTask(anchorId) })` |
| `planning.js` `resolveAuto` / `resolveIgnore` / `unignore(taskId)` | `assertEditable()` | `assertEditable(false, { kind:'task', task: ctx.getTask(taskId) })` |
| `persistence.js` `importJSON` / `resetToDefault` | `assertEditable(true)` / `assertEditable()` | `assertEditable(true, { kind:'plan' })` |

**专项说明①：`saveTask`**。它的 `taskId` 可能是新任务（新增分支），此时 `findRawBar(taskId)` 为 null。改为：

```js
  function saveTask(taskId, draft) {
    const raw = taskId ? findRawBar(taskId) : null;
    // 新增分支（raw 为空、committed 还没推入 bars）按"打算派给谁"判定；
    // 编辑分支按"这条任务现在归谁"判定 —— 注意用 old 的 res，不能用 draft.res，
    // 否则协作者把自己的任务 res 改成别人就能绕过（改完就成别人的了，本不该允许改）
    const isNew = !raw;
    const guard = isNew
      ? { kind: 'taskNew', res: (draft && draft.res) || [] }
      : { kind: 'task', task: raw };
    if (!assertEditable(isNew, guard)) return;
    // …原实现不变…
```
注意把原本的 `assertEditable(true)`（新增分支的抛错语义）改成 `assertEditable(isNew, guard)`。

**专项说明②：`updateModule`**。它是混合粒度，要在字段级守卫之前先单独把归属级字段拦掉：

```js
  function updateModule(opts) {
    const mo = (getState().modules || []).find(m => m.name === (opts.oldName || opts.name));
    if (!mo) return;

    // 归属级字段（改名 / 转交归属）单独把关，错误信息要指对方向 ——
    // 混在字段级里会报成笼统的"只读模式"，用户不知道是哪一步被拦了
    const c = permCtx();
    const renaming = opts.name != null && (opts.name || '').trim() !== mo.name;
    if ((renaming || 'owner' in opts) && !canManageModule(mo, c)) {
      throw new Error(renaming
        ? '无权重命名该需求：该需求不是你创建的'
        : '无权转交该需求：该需求不是你创建的');
    }
    if (!assertEditable(false, { kind: 'moduleFields' })) return;
    // …原实现不变…
```

**专项说明③：`undo`/`redo`**（`src/scheduler/index.js:95-104`）。这两个方法原来没有守卫，而它们回滚的是**整份 plan 快照**（会连带回滚别人的改动）：

```js
import { assertEditable } from './mutations.js';
// …
  function undo() {
    if (!assertEditable(false, { kind: 'plan' })) return false;
    const ok = history.undo();
    if (ok) cycle.apply();
    return ok;
  }
  function redo() {
    if (!assertEditable(false, { kind: 'plan' })) return false;
    const ok = history.redo();
    if (ok) cycle.apply();
    return ok;
  }
```

- [ ] **Step 5: 逐条跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.js`
Expected: PASS

- [ ] **Step 6: 跑全量测试 —— 这一步最容易暴露漏改的调用点**

Run: `npm test`
Expected: PASS。若 `tests/scheduler.test.js:527,533,542,773`、`tests/version.test.js`、`tests/module-archive.test.js`、`tests/req-page.test.js` 里出现新红，**优先怀疑漏传 target 导致落到最严的 `canPlan`**，而不是去改断言。

- [ ] **Step 7: 提交**

```bash
git add src/scheduler/ tests/scheduler.test.js
git commit -m "feat(权限): assertEditable 支持按目标粒度守卫，undo/redo 补上数据层守卫"
```

---

### Task 7b: `setProgress` mutation（资源工作视图的进度编辑，数据层）

> **插入位置**：紧跟 Task 7，属于 MR3。设计见 spec §9.1。

**Files:**
- Modify: `src/scheduler/mutations.js`（新增 `setProgress` + 加进导出清单）
- Modify: `src/scheduler/index.js`（挂到 `sched.setProgress`）
- Test: `tests/scheduler.test.js`

**Interfaces:**
- Consumes: Task 7 的 `assertEditable(throwing, target)`
- Produces: `sched.setProgress(taskId, pct) => number | null` —— 返回归一化后的百分比；被守卫拦下或不适用时返回 `null`

**为什么必须新写**：`saveTask()` 的编辑分支**不写 `done`**（`t.done = committed.done`，从既有值继承）；现有唯一改 `done` 的路径是右键菜单的 `saveTask(id, { complete: true })`，它只会把 `done` 设成 100，表达不了"我现在 40%"。

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.js` 末尾追加：

```js
describe('scheduler: setProgress', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });

  it('写入归一化后的整数百分比', () => {
    const sched = makeSched();
    expect(sched.setProgress('m1-req', 40)).toBe(40);
    expect(sched.getTask('m1-req').done).toBe(40);
  });

  it('越界与小数被钳制/取整，非法值不动数据', () => {
    const sched = makeSched();
    expect(sched.setProgress('m1-req', 140)).toBe(100);
    expect(sched.getTask('m1-req').done).toBe(100);
    expect(sched.setProgress('m1-req', -20)).toBe(0);
    expect(sched.getTask('m1-req').done).toBe(0);
    expect(sched.setProgress('m1-req', 33.7)).toBe(34);
    // 非数值（含空串）→ 直接返回 null，不把 done 写成 NaN
    expect(sched.setProgress('m1-req', '')).toBe(null);
    expect(sched.setProgress('m1-req', 'abc')).toBe(null);
    expect(sched.getTask('m1-req').done).toBe(34);
  });

  it('不存在的任务 / 里程碑 → null 且不报错', () => {
    const sched = makeSched();
    expect(sched.setProgress('no-such-id', 50)).toBe(null);
    // m1-cfm 是里程碑（0 天单点，没有完成度概念）
    expect(sched.setProgress('m1-cfm', 50)).toBe(null);
    expect(sched.getTask('m1-cfm').done).toBeUndefined();
  });

  it('协作者能改自己负责的任务', () => {
    const sched = makeSched();
    asCollab();
    expect(sched.setProgress('m1-req', 60)).toBe(60);      // res = ["张三"]
  });

  it('协作者改不了别人负责的任务（静默不生效）', () => {
    const sched = makeSched();
    asCollab();
    const before = sched.getTask('m1-sit').done;           // res = ["吴十"]
    expect(sched.setProgress('m1-sit', 60)).toBe(null);
    expect(sched.getTask('m1-sit').done).toBe(before);
  });

  it('数据层对未分配任务仍然放行（本页的"未分配只读"是界面口径，不是数据层口径）', () => {
    const sched = makeSched();
    asCollab();
    // 显式造一条未分配任务
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: [], id: 'U' });
    expect(sched.setProgress('U', 30)).toBe(30);
  });

  it('只读模式拦下', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(sched.setProgress('m1-req', 50)).toBe(null);
  });

  it('改进度不改变任何日期（不触发重排）', () => {
    const sched = makeSched();
    const before = JSON.stringify(planStore.state.modules.map(m => m.bars.map(b => [b.s, b.e, b.m])));
    sched.setProgress('m1-req', 80);
    const after = JSON.stringify(planStore.state.modules.map(m => m.bars.map(b => [b.s, b.e, b.m])));
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.js -t "setProgress"`
Expected: FAIL —— `sched.setProgress is not a function`

- [ ] **Step 3: 实现 `setProgress`**

`src/scheduler/mutations.js`，在 `renameTask` 附近插入（它同为"单任务单字段"类）：

```js
  // 设置任务完成度（0–100 整数）。
  // 为什么单独一条：saveTask 的编辑分支不写 done（从既有值继承），
  // 而 { complete: true } 只能表达"100%"，没法表达"我现在 40%"。
  // 改进度不影响日期，因此刻意不做 recomputeAffected —— 进度与排期是正交的两件事。
  function setProgress(taskId, pct) {
    const raw = taskId ? findRawBar(taskId) : null;
    if (!raw) return null;
    if (raw.m) return null;                       // 里程碑是 0 天单点，没有完成度概念
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n)) return null;         // 空串 / 非数值 → 不动数据，避免写入 NaN
    if (!assertEditable(false, { kind: 'task', task: raw })) return null;
    const v = Math.max(0, Math.min(100, n));
    raw.done = v;
    ctx.save();                                   // 落进撤销栈，可 Ctrl+Z 撤回
    return v;
  }
```

并加进 `mutations.js` 末尾的导出清单（与 `renameTask`、`deleteTask` 并列）：

```js
    setProgress,
```

- [ ] **Step 4: 挂到 `sched`**

`src/scheduler/index.js` 的返回对象里，在 `saveTask: mutations.saveTask,` 之后加：

```js
    setProgress: mutations.setProgress,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.js`
Expected: PASS（含新增 8 条）

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/scheduler/mutations.js src/scheduler/index.js tests/scheduler.test.js
git commit -m "feat(任务): 新增 setProgress 完成度写入（供资源工作视图改进度）"
```

---

### Task 8: 级联断链（遇他人任务钉住 + 报冲突）

**Files:**
- Modify: `src/scheduler/planning.js`（新增 `modByName` / `buildSuccIndex` / `isCollabMode` / `collectAffectedCapped`；改 `cascade` / `previewCascade` / `resolveAuto`）
- Modify: `src/components/drag.js:191`（用返回的 `pinned` 提示）
- Test: `tests/scheduler.test.js`

**Interfaces:**
- Consumes: Task 7 的 `assertEditable`、Task 1 的 `canTouchTask` / `ctxOf`
- Produces:
  - `sched.cascade(anchorId, newStart) => { pinned: string[] }`
  - `sched.resolveAuto(taskId) => { pinned: string[] }`
  - `collectAffectedCapped(anchorId, { dryRun }) => { affected: Set, pinned: string[] }`（module 内部）

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.js` 末尾追加：

```js
describe('scheduler: 级联断链', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
  const asFull = () => userStore.set({ readonly: false, access: 'full', resourceName: '张三' });

  it('全权用户：级联照旧，没有任何钉住（回归）', () => {
    const sched = makeSched();
    asFull();
    // m1-dev(钱七) → m1-sit(吴十)：都是别人的任务，全权用户照常全部重排
    const before = sched.getTask('m1-sit').s;
    const r = sched.cascade('m1-dev', '2026-09-20');
    expect(r.pinned).toEqual([]);
    expect(sched.getTask('m1-sit').s).not.toBe(before);
  });

  it('协作者拖自己的任务：下游他人任务被钉住且不再下探', () => {
    const sched = makeSched();
    asCollab();
    // 造一条链：我的任务 A(张三) → 别人的 B(李四) → 我的 C(张三)
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B' });
    sched.addTask({ mod: '官网改版', p: 'uat', start: '2026-09-03', dur: 1, res: ['张三'], id: 'C' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    sched.saveTask('C', { dep: [{ id: 'B', lag: 0 }] });

    const bBefore = sched.getTask('B').s;
    const cBefore = sched.getTask('C').s;
    const r = sched.cascade('A', '2026-09-20');

    expect(r.pinned).toEqual(['B']);                       // B 被钉住
    expect(sched.getTask('B').manual).toBe(true);
    expect(sched.getTask('B').s).toBe(bBefore);            // B 的日期没动
    expect(sched.getTask('C').s).toBe(cBefore);            // 断链 → C 也没动
    expect(sched.getTask('A').s).toBe('2026-09-21');       // 我的 A 正常落位（周一）
  });

  it('断链后会产生「依赖违反」问题（进风险面板）', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    sched.cascade('A', '2026-09-20');
    const probs = sched.detect();
    expect(probs.some(p => p.type === 'depend' && p.taskId === 'B')).toBe(true);
  });

  it('下游是自己人时不断链', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['张三'], id: 'B' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    const r = sched.cascade('A', '2026-09-20');
    expect(r.pinned).toEqual([]);
    expect(sched.getTask('B').s).not.toBe('2026-09-02');
  });

  it('previewCascade 与 cascade 用同一条影响集合（预览必须等于落位）', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    const preview = [...sched.previewCascade('A', '2026-09-20')].sort();
    sched.cascade('A', '2026-09-20');
    // 预览里不应出现 B（它不会被重排）
    expect(preview).not.toContain('B');
    expect(preview).toContain('A');
  });

  it('previewCascade 不产生副作用（预览不写 manual）', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    sched.previewCascade('A', '2026-09-20');
    expect(sched.getTask('B').manual).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.js -t "级联断链"`
Expected: FAIL —— `r.pinned` 为 `undefined`

- [ ] **Step 3: 在 `planning.js` 里加索引与断链收集**

`src/scheduler/planning.js` 顶部 import 追加：

```js
import { userStore } from '../store/user-store.js';
import { ctxOf, canTouchTask } from '../utils/permission.js';
```

在 `createPlanning` 内、`collectAffected` 之前插入：

```js
  // 需求名 → 需求对象（里程碑判定需要知道它属于哪个需求）
  function modByName(name) {
    return (getState().modules || []).find(m => m.name === name) || null;
  }

  // pred→succ 映射（多级递归用）。从 collectAffected 里抽出来，供两个版本共用
  function buildSuccIndex() {
    const succ = {};
    ctx.tasks.forEach(t => (t.dep || []).forEach(d => {
      if (!ctx.tasksById[d.id]) return;
      (succ[d.id] = succ[d.id] || []).push(t.id);
    }));
    return succ;
  }

  // 只有"协作者"才断链：
  //   全权用户 → 完整级联（行为与改造前逐字节相同）
  //   只读用户 → cascade 在第一道守卫就被拦下，到不了这里
  //   access 未显式给出时 ctxOf 返回 full → Task 9 之前本函数恒为 false，零行为变化
  function isCollabMode() { return ctxOf(userStore.state).access === 'collab'; }

  // 协作者版的影响集合：沿后置边遍历时，遇到"我无权编辑"的任务就断链 ——
  //   不重排它，而是把它钉成手动（manual = true），并停止该分支继续下探。
  //   为什么断链就够：被钉住的节点日期没变 → 它下游的依赖输入也没变 → 下游没有变动的理由。
  //   钉住是唯一被特许的跨人写入（设计文档 §6.4 特许①），服务端会校验它确实被级联影响到。
  //   dryRun：预览用，只收集 pinned 不写 manual（预览绝不能有副作用）
  function collectAffectedCapped(anchorId, opts) {
    const dry = !!(opts && opts.dryRun);
    const succ = buildSuccIndex();
    const c = ctxOf(userStore.state);
    const affected = new Set([anchorId]);
    const pinned = [];
    const stack = [anchorId];
    while (stack.length) {
      const id = stack.pop();
      (succ[id] || []).forEach(n => {
        if (affected.has(n)) return;
        const t = ctx.tasksById[n];
        if (!t) return;
        if (!canTouchTask(t, modByName(t.mod), c)) {
          if (!t.manual && !dry) t.manual = true;
          if (!pinned.includes(n)) pinned.push(n);
          return;                       // 断链：不加入 affected、不继续下探
        }
        affected.add(n);
        stack.push(n);
      });
    }
    return { affected, pinned };
  }
```

并让 `collectAffected` 复用 `buildSuccIndex`（把原来函数体内那段构建 `succ` 的代码替换为 `const succ = buildSuccIndex();`）。

- [ ] **Step 4: 改 `cascade` / `previewCascade` / `resolveAuto`**

把 `cascade`（现 `:159-171`）替换为：

```js
  function cascade(anchorId, newStart) {
    const t = ctx.getTask(anchorId);
    if (!t || t.isMs) return { pinned: [] };
    if (!assertEditable(false, { kind: 'task', task: t })) return { pinned: [] };
    t.manual = true;
    const work = W.workDays(t.s, t.e);                       // 拖动前的工作量
    const startD = F(newStart);                              // 兼容 Date 与 'YYYY-MM-DD'
    t.s = fmt(startD);
    t.e = fmt(W.spanEndByWorkdays(startD, work));            // 结束 = 起点起第 work 个工作日
    if (typeof t.w === 'number') t.w = work;                 // 工作量（人天）同步持久化
    let pinned = [];
    if (isCollabMode()) {
      const r = collectAffectedCapped(anchorId);
      pinned = r.pinned;
      recomputeAffected(r.affected);
    } else {
      recomputeAffected(collectAffected(anchorId));
    }
    ctx.save();
    return { pinned };
  }
```

`previewCascade`（现 `:202` 起）里把取 affected 的那行替换为：

```js
    // 预览必须与落位用同一条影响集合，否则会出现"预览在这、松手跑到那"
    const affected = isCollabMode()
      ? collectAffectedCapped(anchorId, { dryRun: true }).affected
      : collectAffected(anchorId);
```

`resolveAuto`（现 `:174-182`）替换为：

```js
  function resolveAuto(taskId) {
    const t = ctx.getTask(taskId);
    if (!t) return { pinned: [] };
    if (!assertEditable(false, { kind: 'task', task: t })) return { pinned: [] };
    t.manual = false;
    t.ignore = false;
    let pinned = [];
    if (isCollabMode()) {
      const r = collectAffectedCapped(taskId);
      pinned = r.pinned;
      recomputeAffected(r.affected);
    } else {
      recomputeAffected(collectAffected(taskId));
    }
    ctx.save();
    return { pinned };
  }
```

`resolveIgnore` / `unignore` 的守卫视 Task 7 已改为任务级，无需再动。

- [ ] **Step 5: `drag.js` 提示钉住结果**

`src/components/drag.js:191`，把 `sched.cascade(barDrag.taskId, newStart);` 替换为：

```js
        const cr = sched.cascade(barDrag.taskId, newStart);
        // 钉住别人任务时要说出来：否则"我碰了别人的任务"这件事在界面上完全不可见，
        // 出争议时查不出是谁引起的（被钉的任务自带「手动」锁图标，那是持久线索）
        if (cr && cr.pinned && cr.pinned.length && typeof deps.onSyncStatus === 'function') {
          deps.onSyncStatus('ok', {
            msg: `已钉住 ${cr.pinned.length} 条他人任务为手动，风险面板会报出依赖冲突`
          });
        }
```

同样，`sched.resizeTask(...)`（现 `:175`）与「一键修复」的调用点若收到 `{pinned}`，按同样方式提示。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.js`
Expected: PASS（含新增 6 条）；既有的 `cascade` 相关用例若依赖返回值仍应全绿（返回值是从 `undefined` 变成对象，属向后兼容的扩宽）

- [ ] **Step 7: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/scheduler/planning.js src/components/drag.js tests/scheduler.test.js
git commit -m "feat(权限): 级联遇他人任务时断链——钉为手动并报依赖冲突"
```

---

## Phase 4 — 放权（本任务之后协作者才开始可写）

### Task 9: `access` 注入（userStore + profile + main-gantt）

**Files:**
- Modify: `src/store/user-store.js`
- Modify: `src/services/backends/supabase.js:41-49`（`getProfile` 的 select）
- Modify: `src/services/backends/feishu.js:70-73`（`getProfile` 返回值）
- Modify: `src/main-gantt.js:255-269`（档案注入）与 `:217-221`（access 计算）
- Test: `tests/core.test.js`（userStore reset 的既有用例）

**Interfaces:**
- Consumes: Task 1 的 `resolveAccess` / `ACCESS` / `ctxOf`
- Produces: `userStore.state` 新增 `resourceName: string`、`isOwner: boolean`、`access: 'full'|'collab'|'readonly'`；`role` 提升为 state 顶层字段

- [ ] **Step 1: 加测试断言**

`tests/core.test.js` 里 userStore 的 reset 用例（现 `:395-413`）补上三个新字段：

```js
  it('userStore.reset 清空权限相关字段', () => {
    userStore.set({ resourceName: '张三', isOwner: true, access: 'collab' });
    userStore.reset();
    expect(userStore.state.resourceName).toBe('');
    expect(userStore.state.isOwner).toBe(false);
    expect(userStore.state.access).toBe('full');   // 兼容默认：非只读即"能改"
    expect(userStore.state.readonly).toBe(false);
    expect(userStore.state.role).toBe('user');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core.test.js -t "权限相关字段"`
Expected: FAIL —— `resourceName` 为 `undefined`

- [ ] **Step 3: 改 `user-store.js`**

把整个 state 与 `reset()` 替换为：

```js
// 当前用户 / 角色 / 项目上下文（替代 window.CURRENT_USER/window.READONLY）
//
// access（权限级别）与 readonly（能不能写）的关系（设计文档 §8.2）：
//   access = 'full'     → 管理员 / 所属人
//   access = 'collab'   → 已登录 且 profiles.resource_name 非空
//   access = 'readonly' → 其余（游客 / 没配人名 / 全局只读）
//   readonly 恒等于 (access === 'readonly')，既有 19 个组件的 isReadonly() 语义不变
export const userStore = {
  state: {
    user: null, role: 'user', resourceName: '', isOwner: false,
    // 兼容默认值：未显式给出 access 且非只读时，permission.ctxOf 视作 'full'
    //（等价改造前"readonly=false 就是能改"）。真实值由 main-gantt 的 initProject 写入。
    access: 'full',
    project: null, projectId: null, readonly: false
  },
  _listeners: new Set(),
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  set(patch) { Object.assign(this.state, patch); this.emit(); },
  reset() {
    this.state = {
      user: null, role: 'user', resourceName: '', isOwner: false,
      access: 'full', project: null, projectId: null, readonly: false
    };
    this.emit();
  },
  emit() { this._listeners.forEach(fn => { try { fn(this.state); } catch (e) {} }); }
};
```

- [ ] **Step 4: 让 `getProfile` 带回 `resource_name`**

`src/services/backends/supabase.js` 的 `getProfile`，select 改为：

```js
      .select('id,display_name,role,resource_name')
```

`src/services/backends/feishu.js` 的 `getProfile`（现 `:71`），返回值改为：

```js
    if (u && u.id === userId) {
      return { data: { role: u.role, display_name: u.display_name, resource_name: u.resource_name }, error: null };
    }
```

（飞书后端本次不做权限校验，但字段要能透出，否则飞书模式下所有人都会被降级成只读。）

- [ ] **Step 5: 改 `main-gantt.js` 的档案注入**

把 `src/main-gantt.js:255-269` 里 `if (user) { … }` 那段替换为：

```js
      if (user) {
        // 档案里的 role 与"对应人员"必须一起注入：任务级权限全靠 resource_name，
        // 少了它协作者会被降级成只读（表现为"我明明配了人名却什么都不能改"）
        const { data: prof } = await getProfile(user.id);
        const role = (prof && prof.role) || 'user';
        userStore.set({
          user: { id: user.id, email: user.email || '', role },
          role,
          resourceName: (prof && prof.resource_name) || ''
        });
      }
```

- [ ] **Step 6: 改 `main-gantt.js` 的访问级别计算**

`src/main-gantt.js` 顶部 import 追加：

```js
import { resolveAccess, ACCESS } from './utils/permission.js';
```

把 `initProject` 里的 `editable` 判定（现 `:217-221`）替换为：

```js
    // 访问级别判定（设计文档 §5.1 / §8.2）：
    //   全权 = 管理员 或 本项目所属人
    //   协作 = 已登录 且 配了"对应人员"（profile.resource_name）
    //   只读 = 其余：游客、没配人名的登录用户
    // 没配人名降级为只读是刻意的：login.html 有公开自助注册入口，
    // 若"没配人名也能改需求/版本"，任何人注册一个账号就能动别人的需求。
    const me = userStore.state.user;
    const isOwner = !!me && !!p && p.owner_id === me.id;
    const access = resolveAccess({
      role: me ? me.role : 'user',
      isOwner,
      resourceName: userStore.state.resourceName
    });
    userStore.set({ isOwner, access, readonly: access === ACCESS.READONLY });
```

- [ ] **Step 7: 跑测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 手工端到端验证（本任务第一次真正放权，必须手验）**

准备：管理员在用户管理页把某个普通账号的「对应人员」设为 `张三`（若无界面可用 SQL：`update profiles set resource_name='张三' where id='…'`），并用该账号登录。

| 场景 | 预期 |
|---|---|
| 进入**自己不是所属人**的项目 | 能进入，工具栏「自动计划/撤销/重做/导入/资源库」灰化 |
| 拖一条 `res` 含自己的任务 | 拖得动，保存成功（状态栏显示已同步） |
| 拖一条 `res` 只有别人的任务 | 拖不动（不响应） |
| 打开别人负责的任务抽屉 | 表单只读，保存/删除不可用 |
| 在需求台账里改**别人需求**的优先级 | 能改，保存成功 |
| 编辑**别人需求**的名字 | 输入框置灰 |
| 归档**别人需求** | 按钮不可用 |
| 新建任务 | 成功，负责人默认自己 |
| 新建需求 | 成功，展开档案里归属显示为自己 |
| 浏览器控制台直接 `PATCH /rest/v1/projects?id=eq.<项目>` | 被 RLS 拒绝（证明服务端仍拦住直连写） |
| 用 curl 调 `save_plan`，plan 里改别人的任务 | 被 `assert_plan_editable` 拒绝，返回 `42501` 与中文原因 |

- [ ] **Step 9: 提交**

```bash
git add src/store/user-store.js src/services/backends/ src/main-gantt.js tests/core.test.js
git commit -m "feat(权限): 注入 access 访问级别与对应人员，协作者开始按归属可写"
```

---

## Phase 5 — 界面收敛

### Task 10: 工具栏按钮分成两组

**Files:**
- Modify: `src/utils/readonly.js`
- Test: `tests/components.test.js`

**Interfaces:**
- Consumes: Task 1 的 `ctxOf`
- Produces: `READONLY_BTN_IDS`（只读禁用；协作者可用）与 `FULL_ONLY_BTN_IDS`（仅全权可用）两个导出

- [ ] **Step 1: 写失败测试**

在 `tests/components.test.js` 追加：

```js
import { READONLY_BTN_IDS, FULL_ONLY_BTN_IDS } from '../src/utils/readonly.js';

describe('readonly: 按钮分组', () => {
  it('两组互不重叠', () => {
    const a = new Set(READONLY_BTN_IDS);
    expect(FULL_ONLY_BTN_IDS.some(id => a.has(id))).toBe(false);
  });
  it('新增类按钮属于 READONLY 组（协作者仍要能用）', () => {
    expect(READONLY_BTN_IDS).toContain('btnAddTask');
    expect(READONLY_BTN_IDS).toContain('btnAddModule');
  });
  it('动整份 plan 的按钮属于 FULL_ONLY 组', () => {
    ['btnAutoPlan', 'btnUndo', 'btnRedo', 'btnImport', 'btnResLib']
      .forEach(id => expect(FULL_ONLY_BTN_IDS).toContain(id));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/components.test.js -t "按钮分组"`
Expected: FAIL —— `FULL_ONLY_BTN_IDS` 未导出

- [ ] **Step 3: 改 `src/utils/readonly.js`**

把 `EDIT_BTN_IDS`（现 `:16-19`）替换为：

```js
// 只读模式下禁用/灰化的编辑类按钮。
// 注意：这些按钮对"协作者"仍然可用（协作者要能新增任务 / 新增需求看问题）
export const READONLY_BTN_IDS = [
  'btnAddTask', 'btnAddModule', 'btnAutoPlan', 'btnProblems', 'btnResLib', 'btnImport', 'btnUndo', 'btnRedo',
  'mAddTask'
];

// 仅"全权用户"（管理员 / 所属人）可用的按钮 —— 它们要么重算整份 plan，要么改项目级数据：
//   btnAutoPlan  全量重排所有自动任务（会动到别人负责的任务）
//   btnUndo/Redo 回滚整份 plan 快照（会连带回滚别人的改动）
//   btnImport    整份替换 modules + resources + versions
//   btnResLib    资源库改名会级联重写全项目任务里的人名
//   CYCLE_BTN_ID 项目周期属于项目级元数据
export const FULL_ONLY_BTN_IDS = ['btnAutoPlan', 'btnUndo', 'btnRedo', 'btnImport', 'btnResLib'];
```

并把 `refreshUI` 替换为：

```js
function refreshUI(doc) {
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
  const noFull = ro || ctxOf(userStore.state).access !== 'full';
  FULL_ONLY_BTN_IDS.forEach(id => {
    const el = byId(id);
    if (el) el.classList.toggle('disabled', noFull);
  });
}
```

顶部 import 追加 `import { ctxOf } from './permission.js';`

- [ ] **Step 4: 确认 `refreshUI` 在 access 就绪后被调用**

`refreshUI` 由 `enterReadonly` / `leaveReadonly` 触发。检查 `src/main-gantt.js` 的 `initProject()`：`userStore.set({ isOwner, access, readonly })` 之后才 `wireUI()`（内部会走只读初始化）。
**若只读未触发（协作者不 readonly），`refreshUI` 不会被调用 → `FULL_ONLY` 按钮不会灰化。** 在 `initProject` 里 `userStore.set({...})` 之后补一行显式刷新：

```js
import { refreshUI as refreshReadonlyUI } from './utils/readonly.js';
// …
    userStore.set({ isOwner, access, readonly: access === ACCESS.READONLY });
    refreshReadonlyUI(document);   // access 就绪后立刻刷新两组按钮的灰化状态
```

（为此在 `src/utils/readonly.js` 里把 `refreshUI` 导出：`export function refreshUI(doc) {...}`。）

- [ ] **Step 5: 跑测试 + 全量**

Run: `npx vitest run tests/components.test.js && npm test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/utils/readonly.js src/main-gantt.js tests/components.test.js
git commit -m "feat(权限): 工具栏按钮按 readonly/full 两组灰化"
```

---

### Task 11: 排期页的任务级写入口按归属收敛

**Files:**
- Modify: `src/components/drag.js:215,236,249`
- Modify: `src/components/task-drawer.js:38-39,95`
- Modify: `src/components/menu-actions.js:18-19,44-69,73-99,118,131,144`
- Modify: `src/components/problem-drawer.js:67-68`
- Test: `tests/context-menu.test.js`、`tests/components.test.js`

**Interfaces:**
- Consumes: Task 1 的 `ctxOf` / `canEditTask` / `canTouchTask` / `canManageModule` / `isMilestone`
- Produces: 无新导出（纯行为收敛）

**统一模式**（以下每个站点都套用）：把"全局只读"判断换成"这条数据归不归我"：

```js
import { userStore } from '../store/user-store.js';
import { ctxOf, canEditTask, canTouchTask, canManageModule } from '../utils/permission.js';

// 原：if (isReadonly()) return;
// 现（普通任务）：
const c = ctxOf(userStore.state);
if (!canEditTask(t, c)) return;
// 现（里程碑 —— 它没有 res，必须按需求归属判定，不能当"未分配"放行）：
if (!canTouchTask(t, modOf(t.mod), c)) return;
```

`modOf(name)` = `(planStore.state.modules || []).find(m => m.name === name) || null`。**每个文件里定义一次**（很小的两行，不值得抽公共模块）。

- [ ] **Step 1: 逐站点替换（清单必须打满，漏一处就是漏一个越权口）**

| 文件:行 | 站点 | target 判定 | 不可编辑时的表现 |
|---|---|---|---|
| `drag.js:215` | 任务条起拖 | `canEditTask(t)` | `return`（不响应） |
| `drag.js:236` | 左右边缘改期 | `canEditTask(t)` | `return` |
| `drag.js:249` | 里程碑拖动 | `canTouchTask(t, modOf(t.mod))` | `return` |
| `task-drawer.js:38-39,95` | 抽屉保存/删除按钮可用性 | `canEditTask(t)`；里程碑 `canTouchTask` | 按钮 `disabled` + 表单字段 `readonly` |
| `menu-actions.js:18-19` | 菜单 flags 组装 | 传入当前任务 | —— |
| `menu-actions.js:44-69` | 任务泳道右键（完成/手动/删除） | `canEditTask(t)` | 菜单项 `disabled` |
| `menu-actions.js:73-99` | 需求泳道右键（归档/删除） | `canManageModule(mo)` | 菜单项 `disabled` |
| `menu-actions.js:118,131,144` | `flags.editable` 计算 | 按上面两条 | —— |
| `problem-drawer.js:67-68` | 「一键修复 / 忽略」 | `canEditTask(该问题对应的任务)` | 按钮隐藏（问题本身仍显示） |

- [ ] **Step 2: 补测试**

`tests/context-menu.test.js` 追加"协作者看到他人任务菜单项 disabled、自己的任务 enabled"；
`tests/components.test.js` 追加"他人任务抽屉只读"。

两个测试都按既有模式构造：`userStore.set({ readonly:false, access:'collab', resourceName:'张三' })`，然后断言 DOM 上的 `disabled` 类 / `readonly` 属性。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/context-menu.test.js tests/components.test.js && npm test`
Expected: PASS

- [ ] **Step 4: 手工验证**

用协作者账号：右键别人的任务 → 菜单项全灰；右键自己的 → 可用；打开别人任务的抽屉 → 字段只读；问题面板里别人任务的问题 → 没有修复/忽略按钮。

- [ ] **Step 5: 提交**

```bash
git add src/components/ tests/context-menu.test.js tests/components.test.js
git commit -m "feat(权限): 拖拽/抽屉/右键菜单/问题面板按任务归属收敛"
```

---
